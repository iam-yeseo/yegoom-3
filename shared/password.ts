/** Same UTF-16 length convention as login/provisioning; never trim passwords. */
export const PASSWORD_RULES = {
  minLength: 12, maxLength: 128, maxBytes: 512, bodyMaxBytes: 2048,
  attempts: 10, windowMs: 15 * 60_000,
} as const;

export function validNewPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= PASSWORD_RULES.minLength
    && value.length <= PASSWORD_RULES.maxLength && new TextEncoder().encode(value).byteLength <= PASSWORD_RULES.maxBytes;
}
