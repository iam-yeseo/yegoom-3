import { useSyncExternalStore, type ReactNode } from "react";

export const art = {
  axolotl: { tint: "#E3F6EE", name: "우파" },
  drop: { tint: "#FFE6DF", name: "방울" },
  cat: { tint: "#FFF4CC", name: "냥냥" },
  bunny: { tint: "#EEE8FC", name: "토끼" },
  bread: { tint: "#FFF4CC", name: "빵빵" },
  manta: { tint: "#E3F1FC", name: "만타" },
  moon: { tint: "#EEE8FC", name: "달빛" },
  monkey: { tint: "#FFF4CC", name: "별숭이" },
} as const;
export type ArtKey = keyof typeof art;
export const artKeys = Object.keys(art) as ArtKey[];
export const artSrc = (key: ArtKey) => `/characters/${key}.png`;

const defaults: Record<string, ArtKey> = {
  min: "axolotl",
  siwon: "cat",
  yeseo: "bunny",
};
export const playerColor: Record<string, string> = {
  min: "#2E8C6E",
  siwon: "#94700A",
  yeseo: "#7556C4",
};

// "My character" is chosen per device until the server stores it.
const storageKey = (username: string) => `yegoom3:character:${username}`;
const listeners = new Set<() => void>();
function readChoice(username: string): ArtKey | null {
  try {
    const value = localStorage.getItem(storageKey(username));
    return value && value in art ? (value as ArtKey) : null;
  } catch {
    return null;
  }
}
export function characterOf(username: string): ArtKey {
  return readChoice(username) ?? defaults[username] ?? "monkey";
}
export function chooseCharacter(username: string, key: ArtKey) {
  try {
    localStorage.setItem(storageKey(username), key);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useCharacter(username: string): ArtKey {
  return useSyncExternalStore(subscribe, () => characterOf(username));
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
export function Avatar({
  username,
  artKey,
  size = 40,
  radius = "50%",
}: {
  username?: string;
  artKey?: ArtKey;
  size?: number;
  radius?: string;
}) {
  const chosen = useCharacter(username ?? "");
  const key = artKey ?? chosen;
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: art[key].tint,
      }}
    >
      <Character artKey={key} />
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
] as const;
export function TabBar({
  active,
  onNavigate,
}: {
  active: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <nav className="tabbar" aria-label="주요 메뉴">
      {tabs.map((tab) => {
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
    <div className="segmented" role="tablist" aria-label={label}>
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
