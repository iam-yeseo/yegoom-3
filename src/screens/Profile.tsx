import { useEffect, useRef, useState } from "react";
import type { LedgerEntry } from "../../shared/types";
import { NICKNAME_MAX, normalizeNickname } from "../../shared/profile";
import { useAttendance } from "../attendance";
import {
  CharacterSprite,
  Avatar,
  Segmented,
  Toolbar,
  art,
  artKeys,
  artSrc,
  useCharacterLookup,
  useDisplayNameLookup,
  useProfile,
  honorific,
  PersonName,
  type ArtKey,
} from "../components/UI";
import { KST, weekdayNames } from "../sample";
import { anim, pop, reduced, useOnChange } from "../motion";
import { formatTime } from "../format";
import { PhotoPicker } from "../components/PhotoPicker";
import { PasswordSheet } from "../components/PasswordSheet";
import { HistoryRow, reasonIcon } from "../components/HistoryRow";
import { TagCollection } from "../components/TagCollection";
import { FONT_SIZES, readFontSize, saveFontSize, type FontSize } from "../font-size";

const dateFormat = new Intl.DateTimeFormat("en-US", { timeZone: KST, month: "numeric", day: "numeric", weekday: "short" });
function dateLabel(iso: string) {
  const parts = Object.fromEntries(
    dateFormat
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  return `${parts.month}월 ${parts.day}일 ${weekdayNames[weekday]}`;
}

export function Profile({
  username,
  displayName,
  attendanceKey,
  gold,
  weeklyScore,
  ledger,
  others,
  onBack,
  onLogin,
  onLogout,
  onFontSizeChange,
  onCharacterChange,
  onDisplayNameChange,
  onPhotoChange,
  onPhotoDelete,
  onPasswordChange,
  tagShopHref = "#/shop/tag",
}: {
  username: string;
  displayName: string;
  attendanceKey: string;
  gold: number;
  weeklyScore: number;
  ledger: LedgerEntry[];
  /** Other players, to label the characters they use. */
  others: string[];
  onBack: () => void;
  onLogin?: () => void;
  onLogout?: () => Promise<void>;
  /** Told once the size actually changes, for the matching achievement. */
  onFontSizeChange?: (size: FontSize) => void;
  onCharacterChange: (character: ArtKey) => Promise<void>;
  onDisplayNameChange: (displayName: string) => Promise<void>;
  onPhotoChange: (photo: string) => Promise<void>;
  onPhotoDelete: () => Promise<void>;
  onPasswordChange?: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Link to the nickname tag shop (the preview keeps its own route prefix). */
  tagShopHref?: string;
}) {
  const characterOf = useCharacterLookup();
  const displayNameOf = useDisplayNameLookup();
  const profile = useProfile(username);
  const [nickname, setNickname] = useState(displayName);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [fontSize, setFontSize] = useState<FontSize>(readFontSize);
  const photoInput = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  useEffect(() => { setNickname(displayName); }, [displayName]);
  const saveNickname = async () => {
    if (editing.current) return;
    setProfileMessage("");
    const checked = normalizeNickname(nickname);
    if ("error" in checked) { setProfileError(checked.error); return; }
    editing.current = true;
    setProfileBusy(true);
    setProfileError("");
    try { await onDisplayNameChange(checked.value); setNickname(checked.value); setProfileMessage("닉네임을 저장했어요."); }
    catch (cause) { setProfileError(cause instanceof Error ? cause.message : "닉네임을 저장하지 못했어요."); }
    finally { editing.current = false; setProfileBusy(false); }
  };
  const deletePhoto = async () => {
    if (editing.current) return;
    editing.current = true;
    setProfileBusy(true);
    setProfileError("");
    setProfileMessage("");
    try { await onPhotoDelete(); setProfileMessage("사진을 삭제했어요. 캐릭터로 보여요."); }
    catch (cause) { setProfileError(cause instanceof Error ? cause.message : "사진을 삭제하지 못했어요."); }
    finally { editing.current = false; setProfileBusy(false); }
  };
  const mine = characterOf(username);
  const { monthCount } = useAttendance(attendanceKey);
  const [currency, setCurrency] = useState<"gold" | "score">("gold");
  const stage = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [characterBusy, setCharacterBusy] = useState(false);
  const [characterError, setCharacterError] = useState("");
  const selecting = useRef(false);
  // Swap: the old character flattens away, then the new one springs up.
  const pick = async (key: ArtKey) => {
    if (key === mine || selecting.current) return;
    selecting.current = true;
    setCharacterBusy(true);
    setCharacterError("");
    const out = anim(stage.current?.querySelector(".profile-character"), [
      { scale: "1 1", opacity: 1 },
      { scale: "1.25 .2", opacity: 0 },
    ], { dur: 200, ease: "inOut" });
    try {
      if (out && !reduced()) await out.finished.catch(() => undefined);
      await onCharacterChange(key);
    } catch (e) {
      setCharacterError(e instanceof Error ? e.message : "캐릭터를 저장하지 못했어요. 다시 골라 주세요.");
    } finally {
      out?.cancel();
      selecting.current = false;
      setCharacterBusy(false);
    }
  };
  useOnChange(mine, () => {
    anim(stage.current?.querySelector(".profile-character"), [
      { scale: ".3 1.3", translate: "0 20px", opacity: 0 },
      { scale: "1.18 .84", translate: "0 0", opacity: 1, offset: 0.55 },
      { scale: ".95 1.05", offset: 0.8 },
      { scale: "1 1", translate: "0 0", opacity: 1 },
    ], { dur: 560, ease: "inOut" });
    pop(grid.current?.querySelector("[aria-pressed='true'] .check"), 1.35);
  });
  useOnChange(currency, () => {
    const dx = currency === "score" ? 28 : -28;
    anim(list.current, [{ translate: `${dx}px 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }], { dur: 280, ease: "spring" });
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owners = new Map<ArtKey, string[]>();
  for (const name of others) {
    const key = characterOf(name);
    owners.set(key, [...(owners.get(key) ?? []), honorific(displayNameOf(name))]);
  }
  const rows = ledger.filter((entry) => entry.currency === currency);
  let lastDate = "";
  return (
    <div className="profile">
      <div className="profile-hero" style={{ backgroundColor: art[mine].tint }}>
        <Toolbar title="내 정보" onBack={onBack} gold={gold} />
        <div className="profile-stage" ref={stage}>
          <i />
          <span className="profile-character">
            <CharacterSprite username={username} state="idle" />
          </span>
        </div>
        <div className="profile-summary">
          <h1><PersonName username={username} fallback={displayName} /></h1>
          <div className="stats">
            <div>
              <span>골드</span>
              <strong>{gold.toLocaleString("ko-KR")}</strong>
            </div>
            <div>
              <span>이번 주</span>
              <strong>{weeklyScore}점</strong>
            </div>
            <div>
              <span>출석</span>
              <strong>{monthCount}일</strong>
            </div>
          </div>
        </div>
      </div>
      <div className="screen-body stack">
        <section className="card profile-editor" aria-busy={profileBusy}>
          <h2>프로필</h2>
          <div className="profile-photo-controls">
            <Avatar username={username} size={68} />
            <div>
              <input ref={photoInput} className="profile-photo-input" type="file" accept="image/*" aria-label="프로필 사진 선택" disabled={profileBusy || busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) { setProfileError(""); setProfileMessage(""); setPhotoFile(file); } }} />
              <button type="button" disabled={profileBusy || busy} onClick={() => photoInput.current?.click()}>{profile?.photoVersion || profile?.photoUrl ? "사진 바꾸기" : "사진 고르기"}</button>
              {(profile?.photoVersion || profile?.photoUrl) && <button type="button" disabled={profileBusy || busy} onClick={() => void deletePhoto()}>사진 삭제</button>}
            </div>
          </div>
          <form onSubmit={event => { event.preventDefault(); void saveNickname(); }}>
            <label className="profile-nickname-label" htmlFor="profile-nickname">닉네임</label>
            <div className="profile-nickname-row"><input id="profile-nickname" value={nickname} autoComplete="nickname" aria-describedby="profile-nickname-help" disabled={profileBusy || busy} onChange={event => { setNickname(event.target.value); setProfileError(""); setProfileMessage(""); }} /><button className="primary-button" type="submit" disabled={profileBusy || busy}>{profileBusy ? "저장 중…" : "닉네임 저장"}</button></div>
            <p id="profile-nickname-help" className="profile-nickname-help">한글·영문·숫자로 1~{NICKNAME_MAX}글자. 로그인 아이디는 그대로예요.</p>
          </form>
          {profileError && <p className="form-message error" role="alert">{profileError}</p>}
          {profileMessage && <p className="profile-edit-success" role="status">{profileMessage}</p>}
        </section>
        <TagCollection shopHref={tagShopHref} />
        <section className="card font-size-setting" aria-label="글자 크기">
          <h2>글자 크기</h2>
          <Segmented label="글자 크기" options={FONT_SIZES.map(({ value, label }) => ({ value, label }))} value={fontSize}
            onChange={next => { if (next === fontSize) return; setFontSize(next); saveFontSize(next); onFontSizeChange?.(next); }} />
          <p>이 기기에만 적용돼요. 글자만 작아지고 화면 배치는 그대로예요.</p>
        </section>
        <section className="card profile-password">
          <button type="button" disabled={!onPasswordChange || profileBusy || busy} onClick={() => setPasswordOpen(true)}>비밀번호 변경</button>
          {!onPasswordChange && <p>미리보기에서는 비밀번호를 바꿀 수 없어요. 로그인 후 이용해 주세요.</p>}
        </section>
        <section className="card character-picker" aria-busy={characterBusy}>
          <h2>내 캐릭터</h2>
          <div className="character-grid" ref={grid}>
            {artKeys.map((key) => (
              <button
                key={key}
                style={{ background: art[key].tint }}
                aria-pressed={key === mine}
                aria-label={`${art[key].name}${owners.has(key) ? `, ${owners.get(key)!.join(", ")}의 캐릭터` : ""}`}
                disabled={characterBusy || busy}
                onClick={() => void pick(key)}
              >
                <img className="character" src={artSrc(key)} alt="" />
                {owners.has(key) && <span className="owner">{owners.get(key)!.join(", ")}</span>}
                {key === mine && (
                  <span className="check" aria-hidden="true">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  </span>
                )}
              </button>
            ))}
          </div>
          {characterBusy && <p className="subtle-note" role="status">캐릭터를 저장하는 중…</p>}
          {characterError && <p className="form-message error" role="alert">{characterError}</p>}
        </section>
        <section className="card history">
          <Segmented
            label="내역 종류"
            options={[
              { value: "gold", label: "골드" },
              { value: "score", label: "점수" },
            ]}
            value={currency}
            onChange={setCurrency}
          />
          <div ref={list}>
          {rows.length ? (
            rows.map((entry) => {
              const date = dateLabel(entry.createdAt);
              const header = date !== lastDate;
              lastDate = date;
              const icon = reasonIcon(entry.reason);
              return (
                <div key={entry.id}>
                  {header && <h3 className="history-date">{date}</h3>}
                  <HistoryRow icon={icon} title={entry.reason} detail={formatTime(entry.createdAt)}
                    amount={entry.amount} unit={currency === "gold" ? "G" : "점"} />
                </div>
              );
            })
          ) : (
            <p className="history-empty">아직 내역이 없어요</p>
          )}
          </div>
        </section>
        {error && (
          <p role="alert" className="form-message error">
            {error}
          </p>
        )}
        {onLogin && (
          <button className="primary-button" onClick={onLogin}>
            로그인하고 함께하기
          </button>
        )}
        {onLogout && (
          <button
            className="text-button logout-button"
            disabled={busy || characterBusy}
            onClick={async () => {
              setBusy(true);
              try {
                await onLogout();
              } catch (e) {
                setError(e instanceof Error ? e.message : "로그아웃하지 못했어요.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "로그아웃 중…" : "로그아웃"}
          </button>
        )}
      </div>
      {photoFile && <PhotoPicker file={photoFile} onClose={() => setPhotoFile(null)} onSave={async photo => { await onPhotoChange(photo); setProfileMessage("프로필 사진을 저장했어요."); }} />}
      {passwordOpen && onPasswordChange && <PasswordSheet username={username} onClose={() => setPasswordOpen(false)} onChange={onPasswordChange} />}
    </div>
  );
}
