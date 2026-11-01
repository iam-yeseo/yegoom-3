export type PhotoMime = 'image/webp' | 'image/jpeg';
/** D1 serializes BLOB query values as byte arrays. Direct adapters may use buffers. */
export type StoredPhotoData = number[] | ArrayBuffer | Uint8Array;
export interface PhotoOptions { maxBytes: number; maxSide: number; exactSide?: number; square?: boolean }
export interface ValidatedPhoto { mime: PhotoMime; data: Uint8Array<ArrayBuffer>; width: number; height: number }
export class PhotoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function invalidPhoto(): never {
  throw new PhotoError(400, 'INVALID_PHOTO', '사진을 읽지 못했어요. WebP 또는 JPEG 사진을 다시 골라 주세요.');
}
function tooLarge(): never {
  throw new PhotoError(413, 'PHOTO_TOO_LARGE', '사진 파일이 너무 커요. 크기를 줄여 다시 올려 주세요.');
}

/** Validate the whole RIFF container and the encoded frame's dimensions. */
function webpDimensions(bytes: Uint8Array): [number, number] {
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length < 26 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WEBP') return invalidPhoto();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return invalidPhoto();
  const uint24 = (at: number) => bytes[at]! + (bytes[at + 1]! << 8) + (bytes[at + 2]! << 16);
  let offset = 12; let frame: [number, number] | null = null; let extended: [number, number] | null = null;
  let alpha = false; let flags = 0;
  while (offset + 8 <= bytes.length) {
    const type = text(offset, 4); const size = view.getUint32(offset + 4, true); const start = offset + 8;
    const end = start + size + (size % 2);
    if (end > bytes.length || (size % 2 && bytes[end - 1] !== 0)) return invalidPhoto();
    if (type === 'VP8X') {
      if (offset !== 12 || extended || size !== 10) return invalidPhoto();
      flags = bytes[start]!;
      if ((flags & 0xc3) || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) return invalidPhoto();
      extended = [1 + uint24(start + 4), 1 + uint24(start + 7)];
    } else if (type === 'VP8 ') {
      if (frame || size < 11 || text(start + 3, 3) !== '\x9d\x01\x2a') return invalidPhoto();
      const tag = uint24(start); const partitionSize = tag >>> 5;
      if ((tag & 1) || ((tag >>> 1) & 7) > 3 || !(tag & 16) || !partitionSize || partitionSize > size - 10) return invalidPhoto();
      frame = [view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff];
    } else if (type === 'VP8L') {
      if (frame || alpha || size < 6 || bytes[start] !== 0x2f) return invalidPhoto();
      const bits = view.getUint32(start + 1, true);
      if ((bits >>> 29) !== 0) return invalidPhoto();
      frame = [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    } else if (type === 'ALPH') {
      if (alpha || frame || !extended || !(flags & 16) || size < 2 || (bytes[start]! & 0xc0) || (bytes[start]! & 3) > 1) return invalidPhoto();
      alpha = true;
    } else if (type === 'ANIM' || type === 'ANMF') return invalidPhoto();
    offset = end;
  }
  if (offset !== bytes.length || !frame || (extended && (extended[0] !== frame[0] || extended[1] !== frame[1]))) return invalidPhoto();
  return frame;
}

/** Follow JPEG markers through every scan and EOI, not only a forged SOF header.
 * Workers have no pixel decoder; framing, tables and dimension checks stay bounded
 * by the uploaded byte limit, just as the reference reads image metadata server-side. */
function jpegDimensions(bytes: Uint8Array): [number, number] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalidPhoto();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; let dimensions: [number, number] | null = null; let progressive = false; let scans = 0;
  const components = new Map<number, number>(); const quantization = new Set<number>(); const huffman = new Set<number>();
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return invalidPhoto();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!dimensions || !scans || offset !== bytes.length) return invalidPhoto();
      return dimensions;
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) return invalidPhoto();
    const length = view.getUint16(offset); const start = offset + 2; const end = offset + length;
    if (length < 2 || end > bytes.length) return invalidPhoto();
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (dimensions || length < 11 || bytes[start] !== 8) return invalidPhoto();
      const count = bytes[start + 5]!;
      if (![1, 3, 4].includes(count) || length !== 8 + 3 * count) return invalidPhoto();
      dimensions = [view.getUint16(start + 3), view.getUint16(start + 1)]; progressive = marker === 0xc2;
      for (let index = 0; index < count; index++) {
        const at = start + 6 + 3 * index; const id = bytes[at]!; const sampling = bytes[at + 1]!; const table = bytes[at + 2]!;
        if (components.has(id) || !(sampling >> 4) || (sampling >> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || table > 3) return invalidPhoto();
        components.set(id, table);
      }
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return invalidPhoto();
    else if (marker === 0xdb) {
      let at = start;
      while (at < end) {
        const spec = bytes[at++]!; const precision = spec >> 4; const table = spec & 15;
        if (precision > 1 || table > 3) return invalidPhoto();
        at += 64 * (precision + 1); if (at > end) return invalidPhoto();
        quantization.add(table);
      }
      if (at !== end || start === end) return invalidPhoto();
    } else if (marker === 0xc4) {
      let at = start;
      while (at < end) {
        const spec = bytes[at++]!;
        if ((spec >> 4) > 1 || (spec & 15) > 3 || at + 16 > end) return invalidPhoto();
        let count = 0; for (let index = 0; index < 16; index++) count += bytes[at + index]!;
        at += 16 + count; if (count > 256 || at > end) return invalidPhoto();
        huffman.add(spec);
      }
      if (at !== end || start === end) return invalidPhoto();
    } else if (marker === 0xdd && length !== 4) return invalidPhoto();
    else if (marker === 0xda) {
      if (!dimensions || length < 8) return invalidPhoto();
      const count = bytes[start]!;
      if (!count || count > components.size || length !== 6 + 2 * count) return invalidPhoto();
      const spectralStart = bytes[end - 3]!; const spectralEnd = bytes[end - 2]!; const approximation = bytes[end - 1]!;
      if (spectralStart > spectralEnd || spectralEnd > 63 || (approximation >> 4) > 13 || (approximation & 15) > 13
        || (!progressive && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0))) return invalidPhoto();
      const seen = new Set<number>();
      for (let index = 0; index < count; index++) {
        const at = start + 1 + 2 * index; const id = bytes[at]!; const tables = bytes[at + 1]!;
        if (!components.has(id) || seen.has(id) || !quantization.has(components.get(id)!) || (tables >> 4) > 3 || (tables & 15) > 3
          || (spectralStart === 0 && !huffman.has(tables >> 4)) || (spectralEnd > 0 && !huffman.has(0x10 | (tables & 15)))) return invalidPhoto();
        seen.add(id);
      }
      offset = end; const entropyStart = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
      if (offset === entropyStart || offset >= bytes.length) return invalidPhoto();
      scans++; continue;
    }
    offset = end;
  }
  return invalidPhoto();
}

export function validatePhoto(value: unknown, options: PhotoOptions): ValidatedPhoto {
  if (typeof value !== 'string') return invalidPhoto();
  if (value.length > Math.ceil(options.maxBytes / 3) * 4 + 23) return tooLarge();
  const match = /^data:image\/(webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) return invalidPhoto();
  let raw: string;
  try { raw = atob(match[2]!); } catch { return invalidPhoto(); }
  if (raw.length > options.maxBytes) return tooLarge();
  if (btoa(raw) !== match[2]) return invalidPhoto();
  const data = Uint8Array.from(raw, character => character.charCodeAt(0));
  const [width, height] = match[1] === 'webp' ? webpDimensions(data) : jpegDimensions(data);
  if (!width || !height || Math.max(width, height) > options.maxSide
    || (options.square && width !== height) || (options.exactSide && (width !== options.exactSide || height !== options.exactSide))) {
    throw new PhotoError(400, 'INVALID_PHOTO_DIMENSIONS', options.exactSide
      ? `${options.exactSide}px 정사각형 사진을 올려 주세요.` : `사진의 긴 변을 ${options.maxSide}px 이하로 줄여 주세요.`);
  }
  return { mime: `image/${match[1]}` as PhotoMime, data, width, height };
}

export function photoResponse(data: StoredPhotoData, mime: PhotoMime): Response {
  const buffer = data instanceof ArrayBuffer ? data : Uint8Array.from(data).buffer;
  return new Response(buffer, { headers: {
    'Content-Type': mime, 'Content-Length': String(buffer.byteLength),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff',
  } });
}
export function photoVersion(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new PhotoError(400, 'INVALID_PHOTO_VERSION', '사진 버전을 확인해 주세요.');
  }
  return Number(value);
}
