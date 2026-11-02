import { CATCHMIND_RULES } from '../shared/balance';
import { CATCHMIND_WORDS } from '../shared/catchmind-words';
import { defaultCharacter } from '../shared/characters';
import type {
  CatchmindAction, CatchmindInput, CatchmindPlayer, CatchmindResponse,
  CatchmindRound, CatchmindGalleryRound, CatchmindGalleryResponse, CatchmindSummary, LedgerEntry,
} from '../shared/types';

const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1AAAAAASUVORK5CYII=';
const guessKey = (value: string) => value.replace(/\s/gu, '');
const person = (username: string): CatchmindPlayer => ({ id: username, username, displayName: username, photoVersion: null, character: defaultCharacter(username) });

/** Render the sample with the same canvas format as a submitted drawing. */
function sampleDrawing(): string {
  if (typeof document === 'undefined') return EMPTY_PNG;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) return EMPTY_PNG;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 512, 512);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const branch = (color: string, width: number) => {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(256, 330); context.lineTo(256, 154);
    context.moveTo(246, 257); context.lineTo(176, 257); context.lineTo(176, 211);
    context.moveTo(266, 283); context.lineTo(337, 283); context.lineTo(337, 231);
    context.stroke();
  };
  branch('#5E6A8A', 62);
  branch('#8FD9C0', 50);
  context.strokeStyle = '#5E6A8A';
  context.lineWidth = 3;
  for (const [x, y] of [[245, 180], [268, 206], [250, 239], [263, 281], [174, 227], [335, 248]]) {
    context.beginPath(); context.moveTo(x - 4, y - 5); context.lineTo(x + 4, y + 5); context.stroke();
  }
  context.fillStyle = '#FF8E7A';
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(196, 326); context.lineTo(316, 326); context.lineTo(302, 407); context.lineTo(210, 407); context.closePath();
  context.fill(); context.stroke();
  context.fillStyle = '#FFB9A6';
  context.beginPath(); context.roundRect(187, 315, 138, 27, 9); context.fill(); context.stroke();
  context.fillStyle = '#FFD866';
  context.beginPath(); context.arc(276, 122, 15, 0, Math.PI * 2); context.fill();
  return canvas.toDataURL('image/png');
}

function imageInput(value: unknown): string {
  if (typeof value !== 'string') throw new Error('그림을 확인해 주세요.');
  const parts = /^data:image\/(png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!parts) throw new Error('PNG 또는 WebP 그림을 사용해 주세요.');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(parts[2]), character => character.charCodeAt(0)); }
  catch { throw new Error('그림을 읽지 못했어요.'); }
  if (bytes.length > CATCHMIND_RULES.maxImageBytes) throw new Error(`그림은 ${CATCHMIND_RULES.maxImageBytes / 1024}KB 이하로 올려 주세요.`);
  const view = new DataView(bytes.buffer);
  let width = 0; let height = 0;
  if (parts[1] === 'png' && bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (parts[1] === 'webp' && bytes.length >= 26 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    }
  }
  if (!width || width !== height) throw new Error('정사각형 그림을 사용해 주세요.');
  return value;
}

/** One offline visit owns the sample round and its subsequent turns. */
export function createCatchmindPreview(viewer: CatchmindPlayer) {
  const player = structuredClone(viewer);
  const drawer = person('siwon');
  const startedAt = Date.now();
  const drawing = sampleDrawing();
  const history: CatchmindGalleryRound[] = Array.from({ length: 12 }, (_, index) => ({
    id: `preview-catchmind-history-${index + 1}`, number: index + 1, drawer: person(index % 2 ? 'min' : 'siwon'),
    answer: '선인장', image: drawing, winner: (index + 1) % 3 === 0 ? person('yeseo') : null,
    endReason: (index + 1) % 3 === 0 ? 'correct' : 'misses', endedAt: new Date(startedAt - (13 - index) * 3_600_000).toISOString(),
  }));
  let turn: CatchmindPlayer | null = drawer;
  let round: CatchmindRound | null = {
    id: 'preview-catchmind-1', number: 13, status: 'open', drawer, word: '선인장', wordVersion: 0,
    rerollsLeft: CATCHMIND_RULES.rerolls, image: drawing, wrongCount: 2, hint: null,
    winner: null, endReason: null, publishedAt: new Date(startedAt - 180_000).toISOString(), endedAt: null,
    guesses: ['구름', '만두'].map((answer, index) => ({ id: `preview-guess-${index}`, player: person('min'), answer,
      correct: false, createdAt: new Date(startedAt - (2 - index) * 60_000).toISOString() })),
  };
  let gold = 0;
  let score = 0;
  let wordHistory = ['선인장'];
  const ledger: LedgerEntry[] = [];
  const receipts = new Map<string, string>();
  const isDrawer = () => round?.drawer.id === player.id;

  function gallery(before = Number.MAX_SAFE_INTEGER): CatchmindGalleryResponse {
    const rows = history.filter(item => item.number < before).sort((a, b) => b.number - a.number);
    const rounds = rows.slice(0, CATCHMIND_RULES.galleryPageSize);
    return structuredClone({ rounds, nextBefore: rows.length > rounds.length ? rounds[rounds.length - 1].number : null });
  }

  function read(): CatchmindResponse {
    const draft = round?.status === 'draft';
    const open = round?.status === 'open';
    const holder = turn?.id === player.id;
    const shown = round && { ...round, word: isDrawer() || round.status === 'ended' ? round.word : null };
    return structuredClone({ catchmind: {
      round: shown, turn, previousRound: gallery(round?.number).rounds[0] ?? null, canClaim: !turn && !draft && !open,
      canReroll: Boolean(draft && holder && (round?.rerollsLeft ?? 0) > 0), canPublish: Boolean(draft && holder),
      canGuess: Boolean(open && !isDrawer()), canEnd: Boolean(open && isDrawer()),
      canNext: Boolean(round?.status === 'ended' && holder),
    }, serverTime: new Date().toISOString() });
  }
  function summary(): CatchmindSummary {
    return structuredClone({ roundId: round?.id ?? null, status: round?.status ?? 'idle', drawer: round?.drawer ?? null,
      turn, wrongCount: round?.wrongCount ?? 0, winner: round?.winner ?? null, answer: round?.status === 'ended' ? round.word : null });
  }
  function nextWord(previous: readonly string[]) {
    const words = CATCHMIND_WORDS.filter(word => !previous.includes(word));
    return words[Math.floor(Math.random() * words.length)];
  }
  function startDraft() {
    const word = nextWord([]);
    wordHistory = [word];
    round = { id: crypto.randomUUID(), number: (round?.number ?? 0) + 1, status: 'draft', drawer: player,
      word, wordVersion: 0, rerollsLeft: CATCHMIND_RULES.rerolls,
      image: null, wrongCount: 0, hint: null, winner: null, endReason: null, publishedAt: null, endedAt: null, guesses: [] };
    turn = player;
  }
  function close(reason: CatchmindRound['endReason'], now: string, won = false) {
    if (!round) return;
    round.status = 'ended'; round.endReason = reason; round.endedAt = now;
    round.winner = won ? player : null;
    history.push({ id: round.id, number: round.number, drawer: round.drawer, answer: round.word!, image: round.image!,
      winner: round.winner, endReason: reason!, endedAt: now });
    turn = won ? player : round.drawer;
    if (!won) return;
    gold += CATCHMIND_RULES.gold; score += CATCHMIND_RULES.score;
    for (const [currency, amount] of [['gold', CATCHMIND_RULES.gold], ['score', CATCHMIND_RULES.score]] as const) {
      ledger.unshift({ id: crypto.randomUUID(), currency, amount, reason: '캐치마인드 정답', createdAt: now });
    }
  }
  function mutate(action: CatchmindAction, input: CatchmindInput): CatchmindResponse {
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new Error('요청 번호를 확인해 주세요.');
    let answer = '';
    if (action === 'guess') {
      if (!('answer' in input) || typeof input.answer !== 'string') throw new Error('답을 적어 주세요.');
      if ([...input.answer].length > CATCHMIND_RULES.maxAnswerLength) throw new Error(`답은 ${CATCHMIND_RULES.maxAnswerLength}글자 이하로 적어 주세요.`);
      answer = input.answer.trim();
      if (!guessKey(answer)) throw new Error('답을 적어 주세요.');
    }
    const payload = JSON.stringify({ action, roundId: input.roundId,
      ...((action === 'reroll' || action === 'publish') && 'wordVersion' in input ? { wordVersion: input.wordVersion } : {}),
      ...(action === 'publish' && 'image' in input ? { image: input.image } : {}), ...(action === 'guess' ? { answer: guessKey(answer) } : {}) });
    const previous = receipts.get(input.requestId);
    if (previous !== undefined) {
      if (previous !== payload) throw new Error('이미 다른 요청에 사용한 번호예요.');
      return read();
    }
    if (input.roundId !== (round?.id ?? null)) throw new Error('새로운 판이 시작됐어요. 다시 확인해 주세요.');
    const now = new Date().toISOString();
    if (action === 'claim') {
      if (!read().catchmind.canClaim) throw new Error('이미 그릴 차례인 사람이 있어요.');
      startDraft();
    } else if (action === 'next') {
      if (!read().catchmind.canNext) throw new Error('다음 그림을 그릴 차례가 아니에요.');
      startDraft();
    } else if (action === 'reroll' || action === 'publish') {
      if (!round || round.status !== 'draft' || !isDrawer()) throw new Error('그릴 차례인 사람만 할 수 있어요.');
      if (!('wordVersion' in input) || input.wordVersion !== round.wordVersion) throw new Error('제시어가 바뀌었어요. 다시 확인해 주세요.');
      if (action === 'reroll') {
        if (round.rerollsLeft < 1) throw new Error('제시어는 더 바꿀 수 없어요.');
        round.word = nextWord(wordHistory); wordHistory.push(round.word); round.wordVersion += 1; round.rerollsLeft -= 1;
      } else {
        round.image = imageInput('image' in input ? input.image : null);
        round.status = 'open'; round.publishedAt = now;
      }
    } else if (action === 'guess') {
      if (!round || round.status !== 'open' || isDrawer()) throw new Error('지금은 이 그림의 답을 말할 수 없어요.');
      const correct = guessKey(answer) === guessKey(round.word!);
      round.guesses.push({ id: crypto.randomUUID(), player, answer, correct, createdAt: now });
      if (correct) close('correct', now, true);
      else {
        round.wrongCount += 1;
        if (round.wrongCount >= CATCHMIND_RULES.hintAfter) {
          const characters = [...round.word!.replace(/\s+/g, '')];
          round.hint = { firstCharacter: characters[0], length: characters.length };
        }
        if (round.wrongCount >= CATCHMIND_RULES.endAfter) close('misses', now);
      }
    } else if (action === 'end') {
      if (!round || round.status !== 'open' || !isDrawer()) throw new Error('출제자만 판을 끝낼 수 있어요.');
      close('manual', now);
    } else throw new Error('알 수 없는 동작이에요.');
    receipts.set(input.requestId, payload);
    return read();
  }
  return { read, mutate, summary, gallery, get gold() { return gold; }, get score() { return score; }, get ledger() { return structuredClone(ledger); } };
}
