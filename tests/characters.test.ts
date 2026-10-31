import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { artKeys, charStates } from '../src/components/UI';

const directory = fileURLToPath(new URL('../public/characters/', import.meta.url));
const stills = artKeys.map((key) => `${key}.png`);
const sprites = artKeys.flatMap((key) => charStates.map((state) => `${key}-${state}.webp`));

describe('character image files', () => {
  it.each(stills)('%s keeps the shared RGBA PNG format', async (name) => {
    const png = await readFile(join(directory, name));
    expect(png.length).toBeGreaterThanOrEqual(33);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
  });

  it.each(sprites)('%s keeps six 512px frames in a bounded WebP strip', async (name) => {
    const webp = await readFile(join(directory, 'sprites', name));
    expect(webp.length).toBeGreaterThanOrEqual(30);
    expect(webp.length).toBeLessThanOrEqual(300_000);
    expect(webp.toString('ascii', 0, 4)).toBe('RIFF');
    expect(webp.readUInt32LE(4) + 8).toBe(webp.length);
    expect(webp.toString('ascii', 8, 12)).toBe('WEBP');
    expect(webp.toString('ascii', 12, 16)).toBe('VP8X');
    expect(webp.readUInt32LE(16)).toBe(10);
    // VP8X stores each canvas dimension minus one as a 24-bit little-endian value.
    expect(webp.readUIntLE(24, 3) + 1).toBe(3072);
    expect(webp.readUIntLE(27, 3) + 1).toBe(512);
  });

  it('contains only the eight stills and forty sprite strips', async () => {
    expect(artKeys).toHaveLength(8);
    expect(charStates).toHaveLength(5);
    expect((await readdir(directory)).sort()).toEqual([...stills, 'sprites'].sort());
    expect((await readdir(join(directory, 'sprites'))).sort()).toEqual([...sprites].sort());
  });
});
