// Rasterize the app's own vector icon. Character samples remain untouched.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const svg = await readFile('public/icons/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
try {
  for (const [file, size] of [['icon-192.png',192],['icon-512.png',512],['maskable-512.png',512],['apple-touch-icon.png',180]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>body{margin:0;background:#FFF9EE}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.screenshot({ path: `public/icons/${file}` });
    await page.close();
  }
} finally { await browser.close(); }
