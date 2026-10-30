// Cloudflare Web Crypto supports PBKDF2 up to 100,000 iterations per deriveBits call.
// Versioned encoding allows a future password hashing upgrade without resetting accounts.
const ITERATIONS = 100_000;
const encoder = new TextEncoder();
function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function unhex(value: string): Uint8Array { return Uint8Array.from(value.match(/.{2}/g) ?? [], pair => parseInt(pair, 16)); }
export async function hashToken(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}
export function randomToken(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function hashPassword(password: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${hex(new Uint8Array(derived))}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [scheme, count, salt, expected] = encoded.split('$');
  if (scheme !== 'pbkdf2-sha256' || count !== String(ITERATIONS) || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{64}$/.test(expected ?? '')) return false;
  const actual = (await hashPassword(password, unhex(salt))).split('$')[3]!;
  let mismatch = 0;
  for (let i = 0; i < expected!.length; i++) mismatch |= actual.charCodeAt(i) ^ expected!.charCodeAt(i);
  return mismatch === 0;
}
// Performs the same KDF work for an unknown username.
export const DUMMY_HASH = `pbkdf2-sha256$${ITERATIONS}$${'00'.repeat(16)}$${'00'.repeat(32)}`;
