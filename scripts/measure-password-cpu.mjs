// Local, isolated WebCrypto benchmark of the actual password primitives.
// Does not contact a server or read real credentials, and never prints secrets.
import { build } from 'esbuild';

const artifact = await build({ entryPoints: ['worker/crypto.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { hashPassword, verifyPassword } = await import(`data:text/javascript;base64,${Buffer.from(artifact.outputFiles[0].text).toString('base64')}`);
const current = 'benchmark-current-password';
const replacement = 'benchmark-replacement-password';
const hash = await hashPassword(current);
const samples = 30;
const percentile = (values, fraction) => Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1].toFixed(3));
async function measure(action) {
  for (let i = 0; i < 3; i++) await action();
  const cpu = [], wall = [];
  for (let i = 0; i < samples; i++) {
    const cpuStart = process.cpuUsage(), start = performance.now();
    await action();
    const used = process.cpuUsage(cpuStart);
    cpu.push((used.user + used.system) / 1000);
    wall.push(performance.now() - start);
  }
  return { cpuMs: { median: percentile(cpu, .5), p95: percentile(cpu, .95) }, wallMs: { median: percentile(wall, .5), p95: percentile(wall, .95) } };
}
const verify = async () => { if (!await verifyPassword(current, hash)) throw new Error('Benchmark verification failed'); };
const login = await measure(verify);
const change = await measure(async () => { await verify(); await hashPassword(replacement); });
console.log(JSON.stringify({ runtime: process.version, samples, metric: 'Local Node WebCrypto process CPU (user + system), not production Worker CPU', login, change }, null, 2));
