import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { APIResponse, Page, Route } from '@playwright/test';

/** Several real Workers over ONE local D1, each frozen at its own instant.
 *
 * The app keeps running on the first server's origin (so its saved requests
 * and drafts stay where they are), and `ServerClock.moveTo` sends its API
 * calls to the Worker frozen at a later instant: the same database, a later
 * server clock. Nothing in the production Worker knows about this; the clock
 * is compiled into each test artifact by scripts/e2e-server.mjs. */
export interface ClockServers { origins: string[]; stop(): Promise<void> }

async function waitFor(origin: string, child: ChildProcess) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`E2E server ${origin} exited with ${child.exitCode}`);
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* Not listening yet. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`E2E server ${origin} did not start`);
}

export async function startClockServers(name: string, firstPort: number, instants: readonly string[], profile?: string): Promise<ClockServers> {
  const persist = `.test-build/e2e-shared-${name}-${process.pid}`;
  const children: ChildProcess[] = [];
  const stop = async () => {
    await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', () => resolve());
      try { process.kill(-child.pid, 'SIGTERM'); } catch { resolve(); }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already closed. */ } }, 5000);
    })));
  };
  const origins: string[] = [];
  try {
    // One after another: the first creates and seeds the database, the others attach to it.
    for (const [index, instant] of instants.entries()) {
      const port = firstPort + index;
      const log = createWriteStream(`/tmp/yegoom-${name}-${port}-${process.pid}.log`);
      const child = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, E2E_PORT: String(port), E2E_NOW: instant, E2E_PERSIST_DIR: persist, ...(index ? { E2E_ATTACH: '1' } : {}), ...(profile ? { E2E_PROFILE: profile } : {}) },
      });
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      children.push(child);
      const origin = `http://localhost:${port}`;
      await waitFor(origin, child);
      origins.push(origin);
    }
  } catch (error) { await stop(); throw error; }
  return { origins, stop };
}

/** Routes this page's API calls to the Worker of the chosen instant. */
export class ServerClock {
  private target: string;
  private constructor(private readonly page: Page, private readonly home: string, private readonly instants: readonly string[], private readonly origins: readonly string[]) {
    this.target = home;
  }
  static async attach(page: Page, servers: ClockServers, instants: readonly string[]): Promise<ServerClock> {
    const clock = new ServerClock(page, servers.origins[0]!, instants, servers.origins);
    await page.clock.setFixedTime(new Date(instants[0]!));
    await page.route(`${clock.home}/api/**`, async route => {
      if (clock.target === clock.home) return route.fallback();
      await route.fulfill({ response: await clock.fetch(route) });
    });
    return clock;
  }
  get origin() { return this.target; }
  /** Asks the current instant's Worker; an interceptor decides what the page then sees. */
  fetch(route: Route): Promise<APIResponse> {
    const request = route.request();
    if (this.target === this.home) return route.fetch();
    // The same-origin check compares Origin with the URL the Worker was asked on.
    const headers = { ...request.headers(), ...(request.method() === 'GET' ? {} : { origin: this.target }) };
    return route.fetch({ url: request.url().replace(this.home, this.target), headers });
  }
  /** The server's clock (and the device's) is now `instants[index]`. */
  async moveTo(index: number) {
    this.target = this.origins[index]!;
    await this.page.clock.setFixedTime(new Date(this.instants[index]!));
  }
  /** Reads through the page's session from the current instant's Worker. */
  async get<T>(path: string, index?: number): Promise<T> {
    return await (await this.page.request.get(`${index === undefined ? this.target : this.origins[index]!}${path}`)).json() as T;
  }
}
