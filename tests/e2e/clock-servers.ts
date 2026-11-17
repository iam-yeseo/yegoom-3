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
  const origins = instants.map((_, index) => `http://localhost:${firstPort + index}`);
  const start = (index: number) => {
    const port = firstPort + index;
    const log = createWriteStream(`/tmp/yegoom-${name}-${port}-${process.pid}.log`);
    const child = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, E2E_PORT: String(port), E2E_NOW: instants[index]!, E2E_PERSIST_DIR: persist, ...(index ? { E2E_ATTACH: '1' } : {}), ...(profile ? { E2E_PROFILE: profile } : {}) },
    });
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    children.push(child);
    return waitFor(origins[index]!, child);
  };
  try {
    // The first creates and seeds the database; the others then attach to it.
    await start(0);
    await Promise.all(instants.slice(1).map((_, index) => start(index + 1)));
  } catch (error) { await stop(); throw error; }
  return { origins, stop };
}

/** The local D1 file has no busy timeout: while one Worker process is still
 * writing (a request sent just before the clock moved), another process's
 * statement fails at once with SQLITE_BUSY and the Worker answers 500 without
 * having stored anything. Production has one database writer and no such
 * state, so the harness asks again; a real server error keeps failing. */
async function settled(send: () => Promise<APIResponse>): Promise<APIResponse> {
  let response = await send();
  for (let attempt = 0; response.status() === 500 && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    response = await send();
  }
  return response;
}

/** Routes this page's API calls to the Worker of the chosen instant. */
export class ServerClock {
  private target: string;
  private at = 0;
  private constructor(private readonly page: Page, private readonly home: string, private readonly instants: readonly string[], private readonly origins: readonly string[]) {
    this.target = home;
  }
  /** `flowing` installs a running fake clock (timers fire as it is advanced)
   * instead of a fixed `Date`: use `advanceTo` and `sleepTo` with it. */
  static async attach(page: Page, servers: ClockServers, instants: readonly string[], flowing = false): Promise<ServerClock> {
    const clock = new ServerClock(page, servers.origins[0]!, instants, servers.origins);
    clock.at = Date.parse(instants[0]!);
    if (flowing) await page.clock.install({ time: new Date(instants[0]!) });
    else await page.clock.setFixedTime(new Date(instants[0]!));
    await page.route(`${clock.home}/api/**`, async route => {
      if (clock.target === clock.home) return route.fallback();
      await route.fulfill({ response: await clock.fetch(route) });
    });
    return clock;
  }
  get origin() { return this.target; }
  /** Asks the current instant's Worker; an interceptor decides what the page then sees. */
  async fetch(route: Route): Promise<APIResponse> {
    const request = route.request();
    const target = this.target;
    // The same-origin check compares Origin with the URL the Worker was asked on.
    const options = target === this.home ? {} : { url: request.url().replace(this.home, target),
      headers: { ...request.headers(), ...(request.method() === 'GET' ? {} : { origin: target }) } };
    return settled(() => route.fetch(options));
  }
  /** The server's clock (and the device's) is now `instants[index]`. */
  async moveTo(index: number) {
    this.target = this.origins[index]!;
    this.at = Date.parse(this.instants[index]!);
    await this.page.clock.setFixedTime(new Date(this.instants[index]!));
  }
  /** Time passes to `instants[index]` on the server and on the device: every
   * timer due on the way fires, as it would in a tab left open. */
  async advanceTo(index: number) {
    const next = Date.parse(this.instants[index]!);
    this.target = this.origins[index]!;
    await this.page.clock.fastForward(next - this.at);
    this.at = next;
  }
  /** The same passage of time for a tab that was asleep: the clocks moved,
   * but no timer ran in between. */
  async sleepTo(index: number) {
    this.target = this.origins[index]!;
    this.at = Date.parse(this.instants[index]!);
    await this.page.clock.setSystemTime(new Date(this.instants[index]!));
  }
  /** Reads through the page's session from the current instant's Worker. */
  async get<T>(path: string, index?: number): Promise<T> {
    const url = `${index === undefined ? this.target : this.origins[index]!}${path}`;
    return await (await settled(() => this.page.request.get(url))).json() as T;
  }
}
