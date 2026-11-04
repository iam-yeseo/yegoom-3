import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ART_KEYS, defaultCharacter, isArtKey, type ArtKey } from "../../shared/characters";
import { anim, useOnChange } from "../motion";
import "../profile-photo.css";
import "../nickname-tags.css";
import { honorific, plainName } from '../names';
import { gradeLabel } from "../../shared/nickname-tags";
import type { NicknameTagView } from "../../shared/types";

export { honorific, plainName } from '../names';

export interface ProfileDirectoryEntry {
  id: string;
  username: string;
  displayName: string;
  photoVersion: number | null;
  /** Only preview stores local data URLs; signed-in photos use versioned URLs. */
  photoUrl?: string | null;
  /** The equipped nickname tag, shown before the nickname everywhere. */
  tag?: NicknameTagView | null;
}
const ProfileDirectory = createContext<{ profiles: ProfileDirectoryEntry[]; preview: boolean }>({ profiles: [], preview: false });
export function ProfileDirectoryProvider({ profiles, preview, children }: { profiles: ProfileDirectoryEntry[]; preview: boolean; children: ReactNode }) {
  return <ProfileDirectory.Provider value={{ profiles, preview }}>{children}</ProfileDirectory.Provider>;
}
export function useProfile(username: string) {
  return useContext(ProfileDirectory).profiles.find(profile => profile.username === username);
}
/** Text form of a player's name: the equipped tag phrase, a space, then the nickname
 * ("반짝이는 시원"). Tags are adjectives, so sentences read naturally with "님" appended.
 * Labels that can render markup use <PersonName> for the styled tag instead. */
export function useDisplayNameLookup() {
  const { profiles } = useContext(ProfileDirectory);
  return useCallback((username: string, fallback?: string) => {
    const profile = profiles.find(entry => entry.username === username);
    const name = profile?.displayName ?? fallback ?? username;
    return profile?.tag?.text ? `${profile.tag.text} ${name}` : name;
  }, [profiles]);
}
/** Same text form, looked up by account id (server notices carry ids). */
export function useDisplayNameByIdLookup() {
  const { profiles } = useContext(ProfileDirectory);
  return useCallback((id: string, fallback: string) => {
    const profile = profiles.find(entry => entry.id === id);
    const name = profile?.displayName ?? fallback;
    return profile?.tag?.text ? `${profile.tag.text} ${name}` : name;
  }, [profiles]);
}
/** The nickname and tag separately, for styled labels. */
export function useNameParts(username: string, fallback?: string): { name: string; tag: NicknameTagView | null } {
  const profile = useContext(ProfileDirectory).profiles.find(entry => entry.username === username);
  return { name: profile?.displayName ?? fallback ?? username, tag: profile?.tag ?? null };
}
/** A tag chip: S hologram, A gold, B silver, C outline. */
export function NickTag({ tag }: { tag: NicknameTagView }) {
  return <span className={`nick-tag nick-tag--${tag.grade.toLowerCase()}`} title={gradeLabel(tag.grade)}>{tag.text}</span>;
}
/** Tag chip + nickname (+ "님" unless it is a ranking label). On a narrow row the
 * tag shrinks with an ellipsis first so the nickname stays whole. */
export function PersonName({ username, fallback, honorific: polite = true }: { username: string; fallback?: string; honorific?: boolean }) {
  const { name, tag } = useNameParts(username, fallback);
  const text = polite ? honorific(name) : plainName(name);
  if (!tag) return <span className="person-name">{text}</span>;
  return <span className="person-name tagged-name"><NickTag tag={tag} /><span className="tagged-name__text">{text}</span></span>;
}
export function useDisplayName(username: string, fallback?: string) {
  return useDisplayNameLookup()(username, fallback);
}

export const art = {
  axolotl: { tint: "#E3F6EE", name: "우파" },
  drop: { tint: "#FFE6DF", name: "방울" },
  cat: { tint: "#FFF4CC", name: "냥냥" },
  bunny: { tint: "#EEE8FC", name: "토끼" },
  bread: { tint: "#FFF4CC", name: "빵빵" },
  manta: { tint: "#E3F1FC", name: "만타" },
  moon: { tint: "#EEE8FC", name: "달빛" },
  monkey: { tint: "#FFF4CC", name: "별숭이" },
} as const satisfies Record<ArtKey, { tint: string; name: string }>;
export type { ArtKey } from "../../shared/characters";
export const artKeys = ART_KEYS;
export const artSrc = (key: ArtKey) => `/characters/${key}.png`;

export const charStates = ["idle", "happy", "sleepy", "greet", "jump"] as const;
export type CharState = (typeof charStates)[number];
export const spritePlayback = {
  idle: { duration: 1800, loop: true },
  happy: { duration: 1200, loop: true },
  sleepy: { duration: 2400, loop: true },
  greet: { duration: 900, loop: false },
  jump: { duration: 680, loop: false },
} as const satisfies Record<CharState, { duration: number; loop: boolean }>;
export const spriteSrc = (key: ArtKey, state: CharState) =>
  `/characters/sprites/${key}-${state}.webp`;

// The reviewed 40 sheets contain PASS/FLAG results only. Record future FAIL
// states here before publishing assets, so they never request a broken strip.
const failedSprites: Partial<Record<ArtKey, readonly CharState[]>> = {};
interface SpriteLoad {
  ready: boolean;
  promise: Promise<boolean>;
}
const spriteLoads = new Map<string, SpriteLoad>();
function loadSprite(key: ArtKey, state: CharState): Promise<boolean> {
  if (failedSprites[key]?.includes(state) || typeof Image === "undefined")
    return Promise.resolve(false);
  const src = spriteSrc(key, state);
  const cached = spriteLoads.get(src);
  if (cached) return cached.promise;
  const entry: SpriteLoad = { ready: false, promise: Promise.resolve(false) };
  spriteLoads.set(src, entry);
  entry.promise = new Promise((resolve) => {
    const image = new Image();
    const failed = () => {
      // A later visit/preload can retry after a temporary offline failure.
      if (spriteLoads.get(src) === entry) spriteLoads.delete(src);
      resolve(false);
    };
    image.onload = async () => {
      try {
        if (typeof image.decode === "function") await image.decode();
        entry.ready = true;
        resolve(true);
      } catch {
        failed();
      }
    };
    image.onerror = failed;
    image.src = src;
  });
  return entry.promise;
}
export const preloadSprites = (key: ArtKey, states: readonly CharState[]) =>
  Promise.all(states.map((state) => loadSprite(key, state)));

const spriteReducedMotion = typeof window === "undefined"
  ? null
  : window.matchMedia("(prefers-reduced-motion: reduce)");
function subscribeSpriteMotion(listener: () => void) {
  spriteReducedMotion?.addEventListener("change", listener);
  return () => spriteReducedMotion?.removeEventListener("change", listener);
}
const spriteMotionSnapshot = () => spriteReducedMotion?.matches ?? false;

export const playerColor: Record<string, string> = {
  min: "#2E8C6E",
  siwon: "#94700A",
  yeseo: "#7556C4",
};

const legacyStorageKey = (username: string) => `yegoom3:character:${username}`;
const previewStorageKey = (username: string) => `yegoom3:preview:character:${username}`;
const previewListeners = new Set<() => void>();
const previewChoices = new Map<string, ArtKey>();
let previewRevision = 0;

/** The caller clears the old device preference only after the server accepts
 * its conditional import, or confirms it already has a preference. */
export function readLegacyCharacter(username: string): ArtKey | null {
  try {
    const value = localStorage.getItem(legacyStorageKey(username));
    return isArtKey(value) ? value : null;
  } catch {
    return null;
  }
}
export function clearLegacyCharacter(username: string): void {
  try { localStorage.removeItem(legacyStorageKey(username)); }
  catch { /* A blocked storage area cannot be migrated on this visit. */ }
}
function readPreviewCharacter(username: string): ArtKey {
  try {
    const value = localStorage.getItem(previewStorageKey(username));
    if (isArtKey(value)) return value;
  } catch { /* Keep the preview usable when storage is unavailable. */ }
  return previewChoices.get(username) ?? defaultCharacter(username);
}
export function choosePreviewCharacter(username: string, key: ArtKey): void {
  previewChoices.set(username, key);
  try { localStorage.setItem(previewStorageKey(username), key); }
  catch { /* In private mode the preview choice lasts for this page only. */ }
  previewRevision += 1;
  previewListeners.forEach(listener => listener());
}
function subscribePreview(listener: () => void) {
  previewListeners.add(listener);
  const changed = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("yegoom3:preview:character:")) {
      previewChoices.clear();
      previewRevision += 1;
      listener();
    }
  };
  window.addEventListener("storage", changed);
  return () => {
    previewListeners.delete(listener);
    window.removeEventListener("storage", changed);
  };
}
const subscribeNothing = () => () => {};
type CharacterDirectory = Record<string, ArtKey | null | undefined>;
const CharacterContext = createContext<{ characters: CharacterDirectory; preview: boolean }>({ characters: {}, preview: false });
export function CharacterProvider({ characters, preview, children }: {
  characters: CharacterDirectory;
  preview: boolean;
  children: ReactNode;
}) {
  return <CharacterContext.Provider value={{ characters, preview }}>{children}</CharacterContext.Provider>;
}
export function useCharacterLookup(): (username: string) => ArtKey {
  const { characters, preview } = useContext(CharacterContext);
  useSyncExternalStore(preview ? subscribePreview : subscribeNothing, () => preview ? previewRevision : 0, () => 0);
  return username => preview ? readPreviewCharacter(username) : characters[username] ?? defaultCharacter(username);
}
export function useCharacter(username: string): ArtKey {
  return useCharacterLookup()(username);
}

export function Character({
  username,
  artKey,
  className = "",
  alt = "",
}: {
  username?: string;
  artKey?: ArtKey;
  className?: string;
  alt?: string;
}) {
  const chosen = useCharacter(username ?? "");
  const key = artKey ?? chosen;
  return (
    <img
      className={`character ${className}`}
      src={artSrc(key)}
      alt={alt}
      draggable={false}
    />
  );
}

/** One sheet playback; remounting this renderer cancels the previous state. */
function SpriteFrames({
  artKey,
  state,
  className,
  onDone,
}: {
  artKey: ArtKey;
  state: CharState;
  className: string;
  onDone?: () => void;
}) {
  const reducedMotion = useSyncExternalStore(subscribeSpriteMotion, spriteMotionSnapshot, () => false);
  const src = spriteSrc(artKey, state);
  const blocked = failedSprites[artKey]?.includes(state) ?? false;
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(() =>
    blocked ? "failed" : spriteLoads.get(src)?.ready ? "ready" : "loading",
  );
  const callback = useRef(onDone);
  callback.current = onDone;
  const finished = useRef(false);
  const finish = useCallback(() => {
    if (!spritePlayback[state].loop && !finished.current) {
      finished.current = true;
      callback.current?.();
    }
  }, [state]);

  useEffect(() => {
    if (blocked || reducedMotion) return;
    let active = true;
    void loadSprite(artKey, state).then((ready) => {
      if (active) setStatus(ready ? "ready" : "failed");
    });
    return () => { active = false; };
  }, [artKey, state, blocked, reducedMotion]);
  useEffect(() => {
    if (reducedMotion || status === "failed") finish();
  }, [reducedMotion, status, finish]);

  const playing = status === "ready" && !reducedMotion && !blocked;
  const playback = spritePlayback[state];
  return (
    <span
      key={playing ? "sprite" : "still"}
      className={`character character-sprite${playing ? " is-playing" : ""} ${className}`}
      aria-hidden="true"
      data-character={artKey}
      data-state={state}
      data-ready={status === "ready"}
      style={{
        backgroundImage: `url("${playing ? src : artSrc(artKey)}")`,
        backgroundSize: playing ? "600% 100%" : "contain",
        animationDuration: `${playback.duration}ms`,
        animationIterationCount: playback.loop ? "infinite" : "1",
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && event.animationName === "character-frames") finish();
      }}
    />
  );
}

export function CharacterSprite({
  username,
  artKey,
  state,
  className = "",
  onDone,
}: {
  username?: string;
  artKey?: ArtKey;
  state: CharState;
  className?: string;
  onDone?: () => void;
}) {
  const chosen = useCharacter(username ?? "");
  const key = artKey ?? chosen;
  return (
    <SpriteFrames
      key={`${key}:${state}`}
      artKey={key}
      state={state}
      className={className}
      onDone={onDone}
    />
  );
}

export function Avatar({
  username,
  artKey,
  userId,
  photoVersion,
  nameFormat = "honorific",
  size = 40,
  radius = "50%",
}: {
  username?: string;
  artKey?: ArtKey;
  userId?: string;
  photoVersion?: number | null;
  nameFormat?: "honorific" | "plain";
  size?: number;
  radius?: string;
}) {
  const chosen = useCharacter(username ?? "");
  const key = artKey ?? chosen;
  const directory = useContext(ProfileDirectory);
  const profile = directory.profiles.find(person => person.username === username || person.id === userId);
  const id = profile?.id ?? userId;
  const version = profile ? profile.photoVersion : photoVersion;
  const source = directory.preview ? profile?.photoUrl : id && version ? `/api/users/${encodeURIComponent(id)}/photo?v=${version}` : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span
      className="avatar"
      data-character={key}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: art[key].tint,
      }}
    >
      {source && source !== failedSource
        ? <img className="avatar-photo" src={source} alt={profile ? `${(nameFormat === 'plain' ? plainName : honorific)(profile.displayName)} 프로필 사진` : "프로필 사진"} onError={() => setFailedSource(source)} />
        : <Character artKey={key} />}
    </span>
  );
}
export function Coin({ size = 21 }: { size?: number }) {
  return (
    <span
      className="coin"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size / 2 }}
    >
      G
    </span>
  );
}
export function Gold({ value }: { value: number }) {
  return (
    <span className="gold">
      <Coin />
      <span>
        {value.toLocaleString("ko-KR")}
        <span className="sr-only"> 골드</span>
      </span>
    </span>
  );
}
export function Chevron({
  direction = "left",
  size = 24,
  color = "currentColor",
  width = 2.4,
}: {
  direction?: "left" | "right";
  size?: number;
  color?: string;
  width?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}
export function Toolbar({
  title,
  onBack,
  gold,
  right,
}: {
  title: string;
  onBack: () => void;
  gold?: number;
  right?: ReactNode;
}) {
  return (
    <header className="game-toolbar">
      <button
        className="icon-button"
        onClick={onBack}
        aria-label="뒤로 가기"
      >
        <Chevron />
      </button>
      <h1>{title}</h1>
      {right ?? (gold !== undefined ? <Gold value={gold} /> : <span />)}
    </header>
  );
}

export const tabs = [
  {
    path: "/",
    label: "홈",
    d: "M4 11l8-7 8 7v8a2 2 0 0 1-2 2h-3v-6H9v6H6a2 2 0 0 1-2-2z",
  },
  {
    path: "/games",
    label: "게임",
    d: "M8 7h8a5.5 5.5 0 0 1 0 11H8A5.5 5.5 0 0 1 8 7zM8 10.5v4M6 12.5h4M15.5 11.5h.01M17.5 13.8h.01",
  },
  {
    path: "/ranking",
    label: "랭킹",
    d: "M7 4h10v5a5 5 0 0 1-10 0zM7 6H4.5v1A3 3 0 0 0 7.5 10M17 6h2.5v1a3 3 0 0 1-3 3M12 14v4M8 20h8",
  },
  {
    path: "/shop",
    label: "상점",
    d: "M5 8h14l-1.2 12H6.2zM9 8V6.5a3 3 0 0 1 6 0V8",
  },
  {
    path: "/profile",
    label: "내 정보",
    d: "M12 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8zM4.5 20c1.4-3.6 4.6-5 7.5-5s6.1 1.4 7.5 5",
  },
  {
    path: "/admin",
    label: "운영",
    d: "M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6zM9 12l2 2 4-4",
  },
] as const;
export function TabBar({
  active,
  onNavigate,
  admin = false,
}: {
  active: string;
  onNavigate: (path: string) => void;
  admin?: boolean;
}) {
  const nav = useRef<HTMLElement>(null);
  useOnChange(active, () => {
    const icon = nav.current?.querySelector("button.on svg");
    anim(
      icon,
      [
        { translate: "0 0", scale: "1 1" },
        { translate: "0 -7px", scale: ".92 1.1", offset: 0.35 },
        { translate: "0 0", scale: "1.1 .9", offset: 0.7 },
        { translate: "0 0", scale: "1 1" },
      ],
      { dur: 420, ease: "inOut", fill: "none" },
    );
  });
  return (
    <nav className={`tabbar${admin ? " tabbar-admin" : ""}`} aria-label="주요 메뉴" ref={nav}>
      {tabs.filter(tab => tab.path !== "/admin" || admin).map((tab) => {
        const on = tab.path === active;
        return (
          <button
            key={tab.path}
            className={on ? "on" : ""}
            aria-current={on ? "page" : undefined}
            onClick={() => onNavigate(tab.path)}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill={on ? "#FFE6DF" : "none"}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={tab.d} />
            </svg>
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
export function SectionTitle({
  title,
  right,
  onClick,
}: {
  title: string;
  right?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {right &&
        (onClick ? (
          <button onClick={onClick}>
            {right}
            <Chevron direction="right" size={12} width={2.6} />
          </button>
        ) : (
          <span>{right}</span>
        ))}
    </div>
  );
}
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  colors,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  colors?: Partial<Record<string, string>>;
  label: string;
}) {
  return (
    <div
      className="segmented"
      role="tablist"
      aria-label={label}
      style={
        {
          "--count": options.length,
          "--index": Math.max(0, options.findIndex((o) => o.value === value)),
        } as React.CSSProperties
      }
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          role="tab"
          aria-selected={option.value === value}
          style={
            option.value === value && colors?.[String(option.value)]
              ? { color: colors[String(option.value)] }
              : undefined
          }
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
