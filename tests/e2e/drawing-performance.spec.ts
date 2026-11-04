import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const execute = promisify(execFile);
test('a dense three-second stroke stays below the Long Task threshold at fourfold CPU slowdown', async ({}, info) => {
  test.setTimeout(90000);
  const output = info.outputPath('drawing-browser-metrics.json');
  await execute(process.execPath, ['scripts/measure-catchmind-browser.mjs', '--url', 'http://localhost:8788', '--output', output],
    { cwd: process.cwd(), env: { ...process.env, CHROMIUM_PATH: process.env.CHROMIUM_PATH || '/usr/bin/chromium' } });
  const report = JSON.parse(await readFile(output, 'utf8'));
  expect(report.cpuThrottle).toBe(4);
  expect(report.inputProtocol).toBe('coalesced');
  expect(report.stroke.sentPointerMoves).toBe(180);
  expect(report.stroke.sampledPoints).toBe(1440);
  expect(report.stroke.longTasks).toEqual([]);
  expect(report.stroke.canvasCalls.getImageData).toBe(0);
  expect(report.stroke.canvasCalls.putImageData).toBe(0);
  expect(report.stroke.canvasCalls.createImageBitmap).toBe(1);
  expect(report.stroke.canvasCalls.quadraticCurveTo).toBeLessThanOrEqual(1445);
  expect(report.stroke.canvasCalls.stroke).toBeLessThanOrEqual(185);
  expect(report.fill.maximumMs).toBeLessThan(100);
  expect(report.apiCalls).toEqual([]);
  await info.attach('fourfold-cpu-drawing-and-fill', { path: output, contentType: 'application/json' });
});
