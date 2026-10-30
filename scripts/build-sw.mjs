import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const dir = 'dist';
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? walk(join(path, entry.name)) : join(path, entry.name)))).flat();
}
const files = (await walk(dir)).filter((file) => !file.endsWith('_headers') && !file.endsWith('sw.js')).sort();
const hash = createHash('sha256');
for (const file of files) hash.update(await readFile(file));
const cache = `yegoom3-${hash.digest('hex').slice(0, 12)}`;
const paths = files.map((file) => file === 'dist/index.html' ? '/' : '/' + file.slice(dir.length + 1));
await writeFile(join(dir, 'sw.js'), `
const CACHE = ${JSON.stringify(cache)};
const FILES = ${JSON.stringify(paths)};
const STATIC = new Set(FILES);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('yegoom3-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Authentication and game results always require a live server; never queue writes.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match('/')).then(response => response || Response.error())));
    return;
  }
  if (STATIC.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(response => response || fetch(request)));
  }
});
`);
console.log(`PWA precache: ${paths.length} static files, ${cache}`);
