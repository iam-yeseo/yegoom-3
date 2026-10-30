import type { ReactNode } from "react";
export const characters: Record<
  string,
  { image: string; tint: string; color: string }
> = {
  min: { image: "axolotl", tint: "#E3F6EE", color: "#2E8C6E" },
  siwon: { image: "cat", tint: "#FFF4CC", color: "#94700A" },
  yeseo: { image: "bunny", tint: "#EEE8FC", color: "#7556C4" },
};
export function Character({
  username,
  className = "",
  alt = "",
}: {
  username: string;
  className?: string;
  alt?: string;
}) {
  return (
    <img
      className={`character ${className}`}
      src={`/characters/${characters[username]?.image ?? "sprite"}.png`}
      alt={alt}
      draggable={false}
    />
  );
}
export function Avatar({
  username,
  size = 40,
}: {
  username: string;
  size?: number;
}) {
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        background: characters[username]?.tint ?? "#FFF4CC",
      }}
    >
      <Character username={username} />
    </span>
  );
}
export function Gold({ value }: { value: number }) {
  return (
    <span className="gold">
      <span className="coin" aria-hidden="true">
        G
      </span>
      <span>
        {value.toLocaleString("ko-KR")}
        <span className="sr-only"> 골드</span>
      </span>
    </span>
  );
}
export function BackIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 5l-7 7 7 7" />
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
        aria-label="홈으로 돌아가기"
      >
        <BackIcon />
      </button>
      <h1>{title}</h1>
      {right ?? (gold !== undefined ? <Gold value={gold} /> : <span />)}
    </header>
  );
}
export function GameIcon({ type }: { type: string }) {
  const paths: Record<string, ReactNode> = {
    wake: (
      <>
        <circle cx="24" cy="25" r="10" />
        <path d="M24 19v7l4 2M11 12l5-4M32 8l5 4M16 35l-3 5M32 35l3 5" />
      </>
    ),
    offwork: (
      <>
        <rect x="9" y="17" width="30" height="22" rx="6" />
        <path d="M18 17v-5h12v5M9 25c8 5 22 5 30 0M21 26v5h6v-5" />
      </>
    ),
    luck: (
      <>
        <path d="m24 5 5.9 12 13.1 1.9-9.5 9.3 2.2 13.1L24 35.1l-11.7 6.2 2.2-13.1L5 18.9 18.1 17Z" />
        <path d="M20 24h.1M28 24h.1M21 29q3 3 6 0" />
      </>
    ),
    catchmind: (
      <>
        <path d="m12 34 3-10L32 7l9 9-17 17-12 3ZM28 11l9 9M16 25l8 8M10 42h29" />
      </>
    ),
    kuji: (
      <>
        <path d="M8 13h32v9a5 5 0 0 0 0 10v9H8v-9a5 5 0 0 0 0-10Z" />
        <path d="M28 17v3m0 5v3m0 5v3M15 20l5 5-5 5" />
      </>
    ),
    claw: (
      <>
        <path d="M24 5v15M15 21h18M15 21l-6 12 6 8M33 21l6 12-6 8M17 28l7 8 7-8" />
        <circle cx="24" cy="18" r="4" />
      </>
    ),
    stock: (
      <>
        <path d="M9 8v32h31M15 31l8-10 7 5 9-14M30 12h9v9" />
      </>
    ),
    shop: (
      <>
        <path d="m11 9-4 12q4 6 9 0 4 6 8 0 4 6 8 0 5 6 9 0l-4-12ZM11 26v14h26V26M20 40V29h8v11" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[type] ?? paths.luck}
    </svg>
  );
}
