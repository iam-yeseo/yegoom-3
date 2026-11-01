export const ART_KEYS = ['axolotl', 'drop', 'cat', 'bunny', 'bread', 'manta', 'moon', 'monkey'] as const;
export type ArtKey = typeof ART_KEYS[number];

export function isArtKey(value: unknown): value is ArtKey {
  return typeof value === 'string' && (ART_KEYS as readonly string[]).includes(value);
}

export function defaultCharacter(username: string): ArtKey {
  if (username === 'min') return 'axolotl';
  if (username === 'siwon') return 'cat';
  if (username === 'yeseo') return 'bunny';
  return 'monkey';
}
