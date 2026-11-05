import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ADMIN_LIMITS, type AdminChange, type AdminClawConfig, type AdminGameSettings, type AdminState, type PredictionRules } from "../../shared/admin";
import { CATCHMIND_RULES } from "../../shared/balance";
import { GAME_RULES } from "../../shared/balance";
import { scoreThresholdLabel, validatePredictionRules } from "../../shared/game-settings";
import type { GameId } from "../../shared/types";
import { Character, honorific } from "../components/UI";
import { formatDateTime, formatTime, formatTimeSeconds } from "../format";
import "../admin.css";

interface Props {
  state: AdminState | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onSaveGame: (id: GameId, rules: PredictionRules, effectiveFrom: string) => Promise<void>;
  onSaveClaw: (config: AdminClawConfig) => Promise<void>;
  /** reason null removes the holiday. */
  onSaveHoliday: (date: string, reason: string | null) => Promise<void>;
  onSetStockAi: (enabled: boolean) => Promise<void>;
  onHideStockNews: (id: string, hidden: boolean) => Promise<void>;
  onPlayClaw: () => void;
  preview?: boolean;
}
const names: Record<GameId, string> = { wake: "기상시간", offwork: "퇴근시간", luck: "행운 점수" };
const copyRules = (rules: PredictionRules): PredictionRules => ({ ...rules, scoreTable: rules.scoreTable.map(tier => ({ ...tier })) });
const numericValue = (value: number) => Number.isFinite(value) ? value : "";
const explain = (error: unknown) => error instanceof Error ? error.message : "저장하지 못했어요. 잠시 후 다시 시도해 주세요.";
const shortDate = (value: string) => `${Number(value.slice(5, 7))}월 ${Number(value.slice(8, 10))}일`;
const units = ["시", "분", "초"] as const;
function timeParts(seconds: number): string[] {
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value));
}
function parseDuration(parts: string[]): number {
  if (!parts.every(value => /^\d+$/.test(value))) return NaN;
  const [hours, minutes, seconds] = parts.map(Number);
  if (minutes > 59 || seconds > 59) return NaN;
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isSafeInteger(total) ? total : NaN;
}

/** Duration hours may exceed 23; only wall-clock deadlines use a 24-hour range. */
function DurationInput({ value, onChange, label, disabled }: { value: number; onChange: (value: number) => void; label: string; disabled: boolean }) {
  const [parts, setParts] = useState(() => timeParts(Number.isFinite(value) ? value : 0));
  useEffect(() => {
    if (Number.isFinite(value) && parseDuration(parts) !== value) setParts(timeParts(value));
  }, [value]);
  return <div className="admin-time-input" role="group" aria-label={label}>
    {units.map((unit, index) => <label key={unit}>
      <input type="number" inputMode="numeric" min="0" max={index ? 59 : undefined} step="1" value={parts[index]} disabled={disabled}
        aria-label={`${label} ${unit}`} onFocus={event => event.currentTarget.select()} onChange={event => {
          const next = [...parts]; next[index] = event.target.value; setParts(next); onChange(parseDuration(next));
        }} />
      <span aria-hidden="true">{unit}</span>
    </label>)}
  </div>;
}
function ClockInput({ value, onChange, label, disabled }: { value: string; onChange: (value: string) => void; label: string; disabled: boolean }) {
  const parts = value.split(":");
  return <div className="admin-time-input admin-clock-input" role="group" aria-label={label}>
    {units.map((unit, index) => <label key={unit}>
      <input type="number" inputMode="numeric" min="0" max={index ? 59 : 23} step="1" value={parts[index] ?? ""} disabled={disabled}
        aria-label={`${label} ${unit}`} onFocus={event => event.currentTarget.select()} onChange={event => {
          const next = [...parts]; next[index] = event.target.value; onChange(next.join(":"));
        }} onBlur={event => {
          if (!/^\d{1,2}$/.test(event.target.value)) return;
          const next = [...parts]; next[index] = event.target.value.padStart(2, "0"); onChange(next.join(":"));
        }} />
      <span aria-hidden="true">{unit}</span>
    </label>)}
  </div>;
}

function PredictionForm({ game, today, tomorrow, disabled, onSave }: {
  game: AdminGameSettings; today: string; tomorrow: string; disabled: boolean;
  onSave: Props["onSaveGame"];
}) {
  const [effectiveFrom, setEffectiveFrom] = useState(tomorrow);
  const [rules, setRules] = useState(() => copyRules(game.scheduledRules ?? game.rules));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = useRef(false);
  const pending = useRef(false);
  const day = useRef(today);
  const formId = useId();
  const source = effectiveFrom === today ? game.rules : game.scheduledRules ?? game.rules;
  const sourceKey = JSON.stringify(source);
  useEffect(() => {
    const changedDay = day.current !== today;
    if (changedDay) { day.current = today; dirty.current = false; setEffectiveFrom(tomorrow); setMessage(""); setError(""); }
    if (!dirty.current) setRules(copyRules(changedDay ? game.scheduledRules ?? game.rules : source));
  }, [sourceKey, today, tomorrow]);
  const blocked = disabled || saving;
  function change(next: PredictionRules) { dirty.current = true; setRules(next); setError(""); setMessage(""); }
  function changeTier(index: number, update: Partial<PredictionRules["scoreTable"][number]>) {
    change({ ...rules, scoreTable: rules.scoreTable.map((tier, at) => at === index ? { ...tier, ...update } : tier) });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    const deadline = rules.deadline.split(":").map(part => /^\d{1,2}$/.test(part) ? part.padStart(2, "0") : part).join(":");
    const validated = validatePredictionRules(game.id, { ...rules, deadline });
    if ("error" in validated) { setError(validated.error); setMessage(""); return; }
    if (effectiveFrom === today && !game.canApplyToday) {
      setError(game.activityReason ?? "오늘은 이미 예측이나 정답이 있어요. 내일부터 적용해 주세요."); return;
    }
    pending.current = true; setSaving(true); setError(""); setMessage("");
    try {
      await onSave(game.id, validated.rules, effectiveFrom);
      dirty.current = false; setRules(copyRules(validated.rules));
      setMessage(effectiveFrom === today ? "오늘 판에 적용했어요." : `${shortDate(effectiveFrom)} 00시 00분부터 적용하도록 저장했어요.`);
    } catch (cause) { setError(explain(cause)); }
    finally { pending.current = false; setSaving(false); }
  }
  return <form className="admin-game-form" onSubmit={save} aria-label={`${names[game.id]} 설정`} aria-busy={saving} noValidate>
    <p className="admin-form-note">{game.scheduledRules ? "내일 예약된 설정을 먼저 보여 드려요. 적용 날짜와 값을 확인해 주세요." : "오늘의 설정을 바탕으로 편집해요."}</p>
    <label className="admin-enabled">
      <span><strong>게임 운영</strong><small>{rules.enabled ? "예측과 정답을 받을 수 있어요" : "선택한 날짜부터 이 게임을 쉬어요"}</small></span>
      <input type="checkbox" role="switch" aria-label={`${names[game.id]} 게임 운영`} checked={rules.enabled} disabled={blocked} onChange={event => change({ ...rules, enabled: event.target.checked })} />
    </label>
    <fieldset className="admin-fieldset" disabled={blocked}>
      <legend>배점표</legend>
      <p className="admin-form-note">기준은 작은 순서로, 점수는 같거나 줄어들게 입력해 주세요.</p>
      <div className="admin-score-head" aria-hidden="true"><span>차이 기준</span><span>점수</span><span /></div>
      <div className="admin-score-rows">
        {rules.scoreTable.map((tier, index) => <div className="admin-score-tier" key={index}>
          <div className="admin-score-row">
            {game.id === "luck" ? <label className="admin-luck-threshold"><input type="number" inputMode="numeric" min="0" step="1" value={numericValue(tier.maxDifference)} aria-label={`${names[game.id]} 배점표 ${index + 1}행 차이 기준`} onChange={event => changeTier(index, { maxDifference: event.target.valueAsNumber })} /><span>점 차이</span></label>
              : <DurationInput value={tier.maxDifference} label={`${names[game.id]} 배점표 ${index + 1}행 차이 기준`} disabled={blocked} onChange={maxDifference => changeTier(index, { maxDifference })} />}
            <label className="admin-tier-points"><input type="number" inputMode="numeric" min={ADMIN_LIMITS.points[0]} max={ADMIN_LIMITS.points[1]} step="1" value={numericValue(tier.points)} aria-label={`${names[game.id]} 배점표 ${index + 1}행 점수`} onChange={event => changeTier(index, { points: event.target.valueAsNumber })} /><span className="sr-only">점</span></label>
            <button className="admin-delete-tier" type="button" aria-label={`${names[game.id]} 배점표 ${index + 1}행 삭제`} disabled={rules.scoreTable.length <= ADMIN_LIMITS.scoreRows[0]} onClick={() => change({ ...rules, scoreTable: rules.scoreTable.filter((_, at) => at !== index) })}>×</button>
          </div>
          <p className="admin-tier-preview">{Number.isSafeInteger(tier.maxDifference) && tier.maxDifference >= 0 && Number.isInteger(tier.points) ? `${scoreThresholdLabel(game.id, tier.maxDifference)} → ${tier.points}점` : "기준과 점수를 입력해 주세요"}</p>
        </div>)}
      </div>
      <button className="admin-add-tier" type="button" disabled={rules.scoreTable.length >= ADMIN_LIMITS.scoreRows[1]} onClick={() => {
        const last = rules.scoreTable.at(-1);
        change({ ...rules, scoreTable: [...rules.scoreTable, { maxDifference: last && Number.isFinite(last.maxDifference) ? last.maxDifference + 1 : 0, points: last && Number.isFinite(last.points) ? last.points : 0 }] });
      }}>+ 배점 행 추가 <span>{rules.scoreTable.length}/{ADMIN_LIMITS.scoreRows[1]}</span></button>
      <p className="admin-form-note">표에 없는 더 큰 차이는 0점이에요.</p>
    </fieldset>
    <fieldset className="admin-fieldset" disabled={blocked}>
      <legend>골드 보상</legend>
      <div className="admin-gold-fields">
        <label><span>참여 골드</span><div><input type="number" inputMode="numeric" min={ADMIN_LIMITS.participationGold[0]} max={ADMIN_LIMITS.participationGold[1]} step="1" value={numericValue(rules.participationGold)} aria-label={`${names[game.id]} 참여 골드`} onChange={event => change({ ...rules, participationGold: event.target.valueAsNumber })} /><span>G</span></div><small>0~{ADMIN_LIMITS.participationGold[1].toLocaleString()}G</small></label>
        <label><span>1등 골드</span><div><input type="number" inputMode="numeric" min={ADMIN_LIMITS.firstGold[0]} max={ADMIN_LIMITS.firstGold[1]} step="1" value={numericValue(rules.firstGold)} aria-label={`${names[game.id]} 1등 골드`} onChange={event => change({ ...rules, firstGold: event.target.valueAsNumber })} /><span>G</span></div><small>0~{ADMIN_LIMITS.firstGold[1].toLocaleString()}G</small></label>
      </div>
    </fieldset>
    <fieldset className="admin-fieldset" disabled={blocked}>
      <legend>예측 마감 시각</legend>
      {game.id === "wake" ? <p className="admin-fixed-deadline">{formatTime(rules.deadline)}<span>기상시간 마감은 고정이에요</span></p>
        : <><ClockInput value={rules.deadline} onChange={deadline => change({ ...rules, deadline })} label={`${names[game.id]} 예측 마감`} disabled={blocked} /><p className="admin-form-note">{game.id === "luck" ? `${formatTime(rules.revealTime!)} 자동 공개 전이어야 해요.` : "한국 시간 기준으로 적용돼요."}</p></>}
    </fieldset>
    <fieldset className="admin-fieldset admin-effective-date" disabled={blocked}>
      <legend>적용 시점</legend>
      <label><input type="radio" name={formId} value={tomorrow} checked={effectiveFrom === tomorrow} onChange={() => { setEffectiveFrom(tomorrow); setError(""); setMessage(""); }} /><span><strong>내일부터 적용</strong><small>{shortDate(tomorrow)} 00시 00분 · 기본</small></span></label>
      <label className={!game.canApplyToday ? "is-unavailable" : undefined}><input type="radio" name={formId} value={today} checked={effectiveFrom === today} disabled={!game.canApplyToday} aria-describedby={`${formId}-today-reason`} onChange={() => { setEffectiveFrom(today); setError(""); setMessage(""); }} /><span><strong>오늘부터 적용</strong><small>{shortDate(today)}의 아직 시작하지 않은 판</small></span></label>
      <p className="admin-form-note" id={`${formId}-today-reason`}>{game.canApplyToday ? "오늘 예측도 정답도 없을 때만 선택할 수 있어요. 저장할 때 다시 확인해요." : game.activityReason ?? "오늘 이미 예측이나 정답이 있어 오늘 설정은 바꿀 수 없어요."}</p>
    </fieldset>
    {error && <p className="admin-form-error" role="alert">{error}</p>}
    {message && <p className="admin-form-success" role="status">{message}</p>}
    <button className="primary-button admin-save" type="submit" disabled={blocked}>{saving ? "저장 중…" : `${names[game.id]} 설정 저장`}</button>
  </form>;
}

function PredictionCard({ game, state, disabled, onSave }: { game: AdminGameSettings; state: AdminState; disabled: boolean; onSave: Props["onSaveGame"] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return <section className={`card admin-game-card admin-game-${game.id}`} aria-label={`${names[game.id]} 운영 설정`}>
    <button className="admin-card-toggle" type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
      <span className="admin-card-art"><Character username={GAME_RULES[game.id].author} /></span>
      <span className="admin-card-title"><strong>{names[game.id]}</strong><span>{formatTime(game.rules.deadline)} 마감 · 참여 {game.rules.participationGold}G</span></span>
      <span className="admin-card-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div className="admin-card-badges"><span className={`pill ${game.rules.enabled ? "mint" : "muted"}`}>{game.rules.enabled ? "오늘 운영" : "오늘은 쉬어요"}</span>{game.scheduledRules && <span className="pill lavender">내일 변경 예정</span>}</div>
    <div id={panel} hidden={!open}><PredictionForm game={game} today={state.today} tomorrow={state.tomorrow} disabled={disabled} onSave={onSave} /></div>
  </section>;
}

const clawExplanation = "플레이어마다 넣은 코인을 세어, 정한 횟수째 판에 강집게(100%)가 나와요. 강집게가 나오거나 인형을 뽑으면 처음부터 다시 세요. 나머지 판은 약집게 힘으로 잡고, 매 판 ±10% 흔들려요. 결과는 이 힘으로 돌린 물리 시뮬레이션이 정해요. 1로 두면 항상 강집게예요. 이 설정은 플레이어에게 보이지 않아요.";
function ClawCard({ config, disabled, onSave, onPlay }: { config: AdminClawConfig; disabled: boolean; onSave: Props["onSaveClaw"]; onPlay: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = useRef(false); const pending = useRef(false); const panel = useId();
  useEffect(() => { if (!dirty.current) setDraft(config); }, [config.payoutEvery, config.weakPickup, config.weakCarry]);
  function change(next: AdminClawConfig) { dirty.current = true; setDraft(next); setError(""); setMessage(""); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setSaving(true); setError(""); setMessage("");
    try { await onSave(draft); dirty.current = false; setMessage("저장했어요. 다음 플레이부터 적용돼요."); }
    catch (cause) { setError(explain(cause)); }
    finally { pending.current = false; setSaving(false); }
  }
  return <section className="card admin-claw-card" aria-label="인형뽑기 운영 설정">
    <button className="admin-card-toggle" type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
      <span className="admin-card-art"><Character artKey="cat" /></span><span className="admin-card-title"><strong>인형뽑기</strong><span>집게 힘 설정과 운영자 플레이</span></span><span className="admin-card-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div className="admin-card-badges"><span className="pill peach">다음 플레이부터 적용</span></div>
    <div id={panel} hidden={!open}>
      <form className="admin-claw-form" aria-label="인형뽑기 집게 힘 설정" onSubmit={save} aria-busy={saving}>
        <p className="admin-claw-explanation">{clawExplanation}</p>
        <fieldset className="admin-fieldset" disabled={disabled || saving}>
          <legend className="sr-only">집게 힘</legend>
          <label className="admin-range"><span>강집게 주기 <output>{draft.payoutEvery}판마다</output></span><input type="range" min={ADMIN_LIMITS.payoutEvery[0]} max={ADMIN_LIMITS.payoutEvery[1]} step="1" value={draft.payoutEvery} aria-label="강집게 주기" onChange={event => change({ ...draft, payoutEvery: Number(event.target.value) })} /><small>{ADMIN_LIMITS.payoutEvery[0]}판마다 <span>{ADMIN_LIMITS.payoutEvery[1]}판마다</span></small></label>
          <label className="admin-range"><span>약집게 들어 올리는 힘 <output>{Math.round(draft.weakPickup * 100)}%</output></span><input type="range" min={ADMIN_LIMITS.weakPowerPercent[0]} max={ADMIN_LIMITS.weakPowerPercent[1]} step="1" value={Math.round(draft.weakPickup * 100)} aria-label="약집게 들어 올리는 힘" onChange={event => change({ ...draft, weakPickup: Number(event.target.value) / 100 })} /><small>{ADMIN_LIMITS.weakPowerPercent[0]}% <span>{ADMIN_LIMITS.weakPowerPercent[1]}%</span></small></label>
          <label className="admin-range"><span>약집게 옮기는 힘 <output>{Math.round(draft.weakCarry * 100)}%</output></span><input type="range" min={ADMIN_LIMITS.weakPowerPercent[0]} max={ADMIN_LIMITS.weakPowerPercent[1]} step="1" value={Math.round(draft.weakCarry * 100)} aria-label="약집게 옮기는 힘" onChange={event => change({ ...draft, weakCarry: Number(event.target.value) / 100 })} /><small>{ADMIN_LIMITS.weakPowerPercent[0]}% <span>{ADMIN_LIMITS.weakPowerPercent[1]}%</span></small></label>
        </fieldset>
        {error && <p className="admin-form-error" role="alert">{error}</p>}
        {message && <p className="admin-form-success" role="status">{message}</p>}
        <button className="primary-button admin-save" type="submit" disabled={disabled || saving}>{saving ? "저장 중…" : "집게 힘 저장"}</button>
      </form>
      <div className="admin-claw-play"><p>운영자 기계는 코인 없이 플레이해요.<br />골드와 점수 보상은 없어요.</p><button className="secondary-button" type="button" onClick={onPlay}>운영자 기계 플레이</button></div>
    </div>
  </section>;
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
function gameForTarget(target: string): GameId | null {
  return (["wake", "offwork", "luck"] as const).find(id => target === id || target === `game:${id}` || target === `game/${id}`) ?? null;
}
function changeSummary(change: AdminChange): string[] {
  const before = record(change.before); const after = record(change.after); const game = gameForTarget(change.target);
  const rows: string[] = [];
  const add = (key: string, name: string, format: (value: unknown) => string = value => String(value ?? "—")) => {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) rows.push(`${name} ${format(before[key])} → ${format(after[key])}`);
  };
  if (game) {
    add("enabled", "운영", value => value === true ? "켜짐" : value === false ? "쉬어요" : "—");
    add("participationGold", "참여", value => `${value ?? "—"}G`); add("firstGold", "1등", value => `${value ?? "—"}G`); add("deadline", "마감", value => typeof value === "string" ? formatTimeSeconds(value) : "—");
    add("scoreTable", "배점표", value => Array.isArray(value) ? value.map(tier => {
      const row = record(tier); return `${scoreThresholdLabel(game, Number(row.maxDifference))} ${row.points}점`;
    }).join(" · ") : "—");
  } else if (change.target === "claw") {
    add("payoutEvery", "강집게 주기", value => `${value ?? "—"}판`);
    const power = (value: unknown) => typeof value === "number" ? `${Math.round(value * 100)}%` : "—";
    add("weakPickup", "들어 올리는 힘", power); add("weakCarry", "옮기는 힘", power);
  }
  return rows.length ? rows : ["적용 설정을 저장했어요."];
}
function Changes({ changes }: { changes: AdminChange[] }) {
  return <section className="admin-changes" aria-label="최근 변경 기록"><h2>최근 변경 기록</h2>
    {changes.length ? <ol>{changes.map(change => {
      const game = gameForTarget(change.target); const summary = changeSummary(change);
      return <li className="card" key={change.id}>
        <div className="admin-change-heading"><strong>{game ? names[game] : change.target === "claw" ? "인형뽑기" : change.target}</strong><time dateTime={change.createdAt}>{formatDateTime(change.createdAt)}</time></div>
        <p className="admin-change-by">{honorific(change.adminName)} · {change.effectiveFrom.length === 10 ? `${shortDate(change.effectiveFrom)}부터 적용` : "다음 플레이부터 적용"}</p>
        <ul>{summary.map((line, index) => <li key={index}>{line}</li>)}</ul>
      </li>;
    })}</ol> : <div className="card admin-empty">아직 변경 기록이 없어요.</div>}
  </section>;
}

/** Temporary market holidays (elections, temporary public holidays). Upcoming
 * news and price events are never shown here (docs/plan-stock.md §1-2). */
function MarketHolidayCard({ state, disabled, onSave }: { state: AdminState; disabled: boolean; onSave: Props["onSaveHoliday"] }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(state.tomorrow);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const panel = useId();
  async function run(action: () => Promise<void>, done: string) {
    if (saving) return;
    setSaving(true); setError(""); setMessage("");
    try { await action(); setMessage(done); } catch (cause) { setError(explain(cause)); } finally { setSaving(false); }
  }
  return <section className="card admin-claw-card admin-holiday-card" aria-label="주식 시장 임시 휴장일">
    <button className="admin-card-toggle" type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
      <span className="admin-card-art"><Character artKey="moon" /></span><span className="admin-card-title"><strong>주식 시장 휴장일</strong><span>주말·공휴일 말고 쉬는 날 추가</span></span><span className="admin-card-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div className="admin-card-badges"><span className="pill peach">{state.marketHolidays.length ? `예정 ${state.marketHolidays.length}일` : "예정 없음"}</span></div>
    <div id={panel} hidden={!open}>
      <ul className="admin-holiday-list">
        {state.marketHolidays.map(holiday => <li key={holiday.date}><span>{shortDate(holiday.date)} · {holiday.reason}</span>
          <button className="text-button" type="button" disabled={disabled || saving} onClick={() => void run(() => onSave(holiday.date, null), "휴장일을 지웠어요.")}>지우기</button></li>)}
      </ul>
      <form className="admin-holiday-form" aria-label="휴장일 추가" onSubmit={(event: FormEvent) => { event.preventDefault(); void run(async () => { await onSave(date, reason.trim()); setReason(""); }, "휴장일을 추가했어요."); }}>
        <fieldset className="admin-fieldset" disabled={disabled || saving}>
          <label className="admin-field"><span>날짜</span><input type="date" required min={state.today} value={date} onChange={event => setDate(event.target.value)} /></label>
          <label className="admin-field"><span>이유</span><input type="text" required maxLength={20} placeholder="예: 선거일" value={reason} onChange={event => setReason(event.target.value)} /></label>
        </fieldset>
        <p className="admin-claw-explanation">이미 장이 열린 날(오늘 9시 이후)은 바꿀 수 없어요. 앞으로의 뉴스와 가격 사건은 운영자도 볼 수 없어요.</p>
        {error && <p className="admin-form-error" role="alert">{error}</p>}
        {message && <p className="admin-form-success" role="status">{message}</p>}
        <button className="primary-button admin-save" type="submit" disabled={disabled || saving || !reason.trim()}>{saving ? "저장 중…" : "휴장일 추가"}</button>
      </form>
    </div>
  </section>;
}

const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
/** AI news switch, spend, and hiding already-published articles (§8-6). */
function StockNewsCard({ state, disabled, onSetAi, onHide }: { state: AdminState; disabled: boolean; onSetAi: Props["onSetStockAi"]; onHide: Props["onHideStockNews"] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panel = useId();
  const { ai, news } = state.stock;
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(explain(cause)); } finally { setBusy(false); }
  }
  return <section className="card admin-claw-card admin-stock-card" aria-label="주식 뉴스 운영">
    <button className="admin-card-toggle" type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
      <span className="admin-card-art"><Character artKey="monkey" /></span><span className="admin-card-title"><strong>주식 뉴스</strong><span>AI 뉴스 켜기·끄기와 공개된 뉴스 숨기기</span></span><span className="admin-card-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div className="admin-card-badges"><span className="pill peach">{!ai.keyConfigured ? "AI 키 없음 · 템플릿" : ai.enabled ? "AI 뉴스 켜짐" : "AI 뉴스 꺼짐"}</span></div>
    <div id={panel} hidden={!open}>
      <dl className="admin-ai-usage">
        <div><dt>오늘</dt><dd>{ai.today.calls}회 · {dollars(ai.today.costMicroUsd)}</dd></div>
        <div><dt>이번 달</dt><dd>{ai.month.calls}회 · {dollars(ai.month.costMicroUsd)}</dd></div>
      </dl>
      <p className="admin-claw-explanation">하루 $0.80에 닿으면 그날은 템플릿 뉴스만 써요. 앞으로 나올 뉴스와 가격 사건은 운영자도 볼 수 없어요.</p>
      <button className="secondary-button" type="button" disabled={disabled || busy} onClick={() => void run(() => onSetAi(!ai.enabled))}>
        {ai.enabled ? "AI 뉴스 끄기" : "AI 뉴스 켜기"}
      </button>
      <ul className="admin-holiday-list admin-news-list" aria-label="공개된 뉴스">
        {news.map(item => <li key={item.id} className={item.hidden ? "hidden-news" : ""}>
          <span><small>{formatDateTime(item.publishAt).slice(6)} · {item.source === "ai" ? "AI" : "템플릿"}</small>{item.headline}</span>
          <button className="text-button" type="button" disabled={disabled || busy} onClick={() => void run(() => onHide(item.id, !item.hidden))}>{item.hidden ? "다시 보이기" : "숨기기"}</button>
        </li>)}
        {!news.length && <li><span>아직 공개된 뉴스가 없어요.</span></li>}
      </ul>
      {error && <p className="admin-form-error" role="alert">{error}</p>}
    </div>
  </section>;
}

export function Admin({ state, loading, error, onReload, onSaveGame, onSaveClaw, onSaveHoliday, onSetStockAi, onHideStockNews, onPlayClaw, preview = false }: Props) {
  return <div className="admin-page">
    <header className="admin-heading"><span className="pill lavender">{preview ? "운영 화면 미리보기" : "운영자 전용"}</span><h1>운영</h1><p>게임 규칙을 확인하고 다음 판을 준비해요.</p></header>
    <div className="screen-body admin-body">
      {preview && <p className="admin-preview-note">여기에서 바꾼 설정은 실제 게임에 반영되지 않아요.</p>}
      {error && <div className="card admin-load-error"><p role="alert">{error}</p><button className="secondary-button" type="button" onClick={onReload}>다시 불러오기</button></div>}
      {!state && !error && <p className="card admin-empty" role="status">운영 설정을 불러오는 중…</p>}
      {state && <>
        {state.catchmindWordsRemaining <= CATCHMIND_RULES.wordWarningThreshold && <p className="card admin-word-warning" role="status">
          캐치마인드 · 남은 제시어 {state.catchmindWordsRemaining}개<br />
          모두 사용하면 새 묶음을 시작해요.
        </p>}
        <section className="admin-predictions" aria-label="예측 게임 운영"><div className="admin-section-heading"><h2>예측 게임</h2><span>{shortDate(state.today)} 기준</span></div>
          {state.games.map(game => <PredictionCard key={game.id} game={game} state={state} disabled={loading} onSave={onSaveGame} />)}
        </section>
        <ClawCard config={state.claw} disabled={loading} onSave={onSaveClaw} onPlay={onPlayClaw} />
        <MarketHolidayCard state={state} disabled={loading} onSave={onSaveHoliday} />
        <StockNewsCard state={state} disabled={loading} onSetAi={onSetStockAi} onHide={onHideStockNews} />
        <Changes changes={state.changes} />
      </>}
    </div>
  </div>;
}
