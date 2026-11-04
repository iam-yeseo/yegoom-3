// Local CPU benchmark of the actual Worker validator; no API requests or credentials.
// Compare a checkout with: node scripts/measure-drawing-cpu.mjs --root /path/to/checkout
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';

const rootIndex = process.argv.indexOf('--root');
const root = resolve(rootIndex < 0 ? '.' : process.argv[rootIndex + 1]);
const source = await readFile(join(root, 'worker/catchmind.ts'), 'utf8');
const artifact = await build({
  stdin: { contents: `${source}\nexport { crc32, CATCHMIND_RULES };`, resolveDir: join(root, 'worker'), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const { validateDrawing, crc32, CATCHMIND_RULES } = await import(`data:text/javascript;base64,${Buffer.from(artifact.outputFiles[0].text).toString('base64')}`);
const maxBytes = CATCHMIND_RULES.maxImageBytes;

// Independent bitwise reference creates checksums without using the measured CRC.
function checksum(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(kind, data) {
  const content = Buffer.concat([Buffer.from(kind), data]);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(checksum(content));
  return Buffer.concat([size, content, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
const pngStart = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(Buffer.alloc(2 * (2 * 4 + 1)))),
]);
const pngEnd = pngChunk('IEND', Buffer.alloc(0));
const keyword = Buffer.from('benchmark\0');
const png = Buffer.concat([pngStart, pngChunk('tEXt', Buffer.concat([
  keyword, Buffer.alloc(maxBytes - pngStart.length - pngEnd.length - 12 - keyword.length, 120),
])), pngEnd]);

// Real 2×2 VP8L image, padded with a permitted unknown RIFF chunk.
const webpBase = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQqMKXp/+BiOh/AAA=', 'base64');
const padding = Buffer.alloc(maxBytes - webpBase.length);
padding.write('JUNK'); padding.writeUInt32LE(padding.length - 8, 4);
const webp = Buffer.concat([webpBase, padding]); webp.writeUInt32LE(webp.length - 8, 4);
const inputs = { png: `data:image/png;base64,${png.toString('base64')}`, webp: `data:image/webp;base64,${webp.toString('base64')}` };
for (const [kind, value] of Object.entries(inputs)) {
  if (validateDrawing(value) !== value) throw new Error(`${kind} fixture did not validate`);
}
if (png.length !== maxBytes || webp.length !== maxBytes) throw new Error('Fixtures must reach the exact byte limit');
if (crc32(png, 0, png.length) !== checksum(png)) throw new Error('CRC mismatch');

const samples = 30;
const percentile = (values, fraction) => Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1].toFixed(3));
function measure(action) {
  for (let i = 0; i < 5; i++) action();
  const cpu = [], wall = [];
  for (let i = 0; i < samples; i++) {
    const cpuStart = process.cpuUsage(), start = performance.now();
    action();
    const used = process.cpuUsage(cpuStart);
    cpu.push((used.user + used.system) / 1000); wall.push(performance.now() - start);
  }
  return { cpuMs: { median: percentile(cpu, .5), p95: percentile(cpu, .95) }, wallMs: { median: percentile(wall, .5), p95: percentile(wall, .95) } };
}
console.log(JSON.stringify({
  runtime: process.version, samples, metric: 'Local Node process CPU (user + system), not production Worker CPU',
  fixture: { decodedBytes: maxBytes, dimensions: '2×2; PNG tEXt / WebP unknown RIFF padding reaches the payload limit', includes: 'base64 validation, decode, byte conversion, container validation; PNG includes CRC' },
  png: measure(() => validateDrawing(inputs.png)),
  webp: measure(() => validateDrawing(inputs.webp)),
  crcOnly: measure(() => crc32(png, 0, png.length)),
}, null, 2));
