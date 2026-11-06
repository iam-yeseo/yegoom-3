import { DAILY_FREE, KUJI_RULES, LAUNCH_GIFT, LOTTO_RULES, NICKNAME_TAG_RULES, SHOP_HISTORY_DAYS, SPEETTO_RULES, SLOT_RULES, attendanceTickets, kujiCost, type DailyFreeKind, lottoPrize, lottoRank } from '../shared/balance';
import type { KujiDraw,
  Inventory, KujiCell, KujiGrade, KujiPurchase, KujiPurchaseInput, KujiResponse,
  LedgerEntry, LottoNotice, LottoPurchaseInput, LottoResponse, LottoTicket, ShopKind, ShopPayment,
  ShopState, SpeettoPurchaseInput, SpeettoResponse, SpeettoSymbol, SpeettoTicket, SlotSpin, SlotSpinInput, SlotResponse,
  NicknameTag, NicknameTagState, TagDrawInput, TagResponse,
} from '../shared/types';
import { drawNicknameTag } from '../shared/nickname-tags';
import { slotResult } from '../shared/slot';

const DAY = 86_400_000;
const kstDate = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const drawAt = (date: string) => Date.parse(`${date}T${LOTTO_RULES.drawTime}+09:00`);
const nextDate = (date: string, days = 1) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const shuffled = <T,>(values: readonly T[]): T[] => {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};
const drawNumbers = () => shuffled(Array.from({ length: LOTTO_RULES.maxNumber }, (_, i) => i + 1))
  .slice(0, LOTTO_RULES.pickCount).sort((a, b) => a - b);

/** A single offline preview visit owns its purchases. Nothing is sent to an API
 * or imported into a real account; the shared economy rules still apply. */
export function createShopPreview(initialGold: number, initialAttendanceBonus = 0, initialAttendanceDate = kstDate(new Date())) {
  let attendanceBonus = initialAttendanceBonus;
  let attendanceDate = initialAttendanceDate;
  let gold = initialGold + attendanceBonus;
  let gameGoldBonus = 0;
  let score = 0;
  const inventory: Inventory = { lottoTickets: 2, speettoTickets: 2, tagTickets: NICKNAME_TAG_RULES.welcomeTickets };
  const attendanceTicketDays = new Set<string>();
  function grantAttendanceTickets(amount: number, date: string) {
    if (amount <= 0 || attendanceTicketDays.has(date)) return;
    const tickets = attendanceTickets(date);
    inventory.lottoTickets += tickets.lottoTickets;
    inventory.speettoTickets += tickets.speettoTickets;
    attendanceTicketDays.add(date);
  }
  grantAttendanceTickets(initialAttendanceBonus, initialAttendanceDate);
  let launchGiftClaimed = false;
  const ledger: LedgerEntry[] = [];
  let boardId = 1;
  let layout: KujiGrade[] = [];
  let cells: KujiCell[] = [];
  let purchaseDate = kstDate(new Date());
  let purchasedToday = 4;
  const lottoTickets: LottoTicket[] = [];
  const speettoTickets: SpeettoTicket[] = [];
  const slotSpins: SlotSpin[] = [];
  // Slot receipts have their own table/request namespace on the server too.
  const slotReceipts = new Map<string, SlotSpin>();
  // Nickname tags drawn in this preview visit only.
  const tags: (NicknameTag & { date: string; discarded?: boolean })[] = [];
  const tagReceipts = new Map<string, NicknameTag & { date: string }>();
  const GRADE_RANK = { S: 0, A: 1, B: 2, C: 3 } as const;
  const draws = new Map<string, number[]>();
  const receipts = new Map<string, {
    kind: ShopKind; payload: string; purchase: KujiPurchase | LottoTicket | SpeettoTicket;
  }>();

  function makeBoard(seed = false) {
    layout = shuffled(KUJI_RULES.grades.flatMap(rule => Array<KujiGrade>(rule.count).fill(rule.grade)));
    const sold = seed ? shuffled(Array.from({ length: KUJI_RULES.size }, (_, i) => i)).slice(0, 37) : [];
    cells = layout.map((grade, position) => {
      const index = sold.indexOf(position);
      return { position, grade: index < 0 ? null : grade, buyerId: index < 0 ? null : index < 4 ? 'preview' : index % 2 ? 'min' : 'siwon' };
    });
  }
  makeBoard(true);
  // Recent draws on the sample board: the sold cells, grouped by buyer, newest first.
  let draws_: KujiDraw[] = [];
  function seedDraws() {
    const sold = cells.filter(cell => cell.buyerId !== null);
    const byBuyer = new Map<string, typeof sold>();
    for (const cell of sold) byBuyer.set(cell.buyerId!, [...(byBuyer.get(cell.buyerId!) ?? []), cell]);
    draws_ = [...byBuyer.entries()].flatMap(([buyer, owned], index) => {
      const chunks: KujiDraw[] = [];
      for (let start = 0; start < owned.length; start += 5) {
        chunks.push({ id: `preview-draw-${buyer}-${start}`, userId: buyer, lastOne: false,
          createdAt: new Date(Date.now() - (index * 5 + start) * 37 * 60_000).toISOString(),
          cells: owned.slice(start, start + 5).map(cell => ({ position: cell.position, grade: cell.grade! })) });
      }
      return chunks;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  seedDraws();

  // A published previous draw gives the result screen an example before the
  // visitor buys a ticket. Its historical prize is already in the sample gold.
  const yesterday = nextDate(purchaseDate, -1);
  const sampleWinning = [3, 7, 12, 18, 24];
  const sampleNumbers = [3, 7, 12, 18, 25];
  const sampleMatches = sampleNumbers.filter(number => sampleWinning.includes(number)).length;
  draws.set(yesterday, sampleWinning);
  lottoTickets.push({ id: 'preview-lotto-history', requestId: 'preview-lotto-history', drawDate: yesterday,
    purchaseDate: yesterday, createdAt: `${yesterday}T12:00:00+09:00`,
    numbers: sampleNumbers, payment: 'gold', cost: LOTTO_RULES.price, winningNumbers: sampleWinning,
    matches: sampleMatches, rank: lottoRank(sampleMatches), prize: lottoPrize(sampleMatches) });
  // An evening visit can demonstrate the home notice without buying a real
  // ticket. As with yesterday's example, its prize is already in sample gold.
  if (Date.now() >= drawAt(purchaseDate)) {
    draws.set(purchaseDate, sampleWinning);
    lottoTickets.unshift({ id: 'preview-lotto-today', requestId: 'preview-lotto-today', drawDate: purchaseDate,
      purchaseDate, createdAt: `${purchaseDate}T16:00:00+09:00`, numbers: sampleNumbers,
      payment: 'gold', cost: LOTTO_RULES.price, winningNumbers: sampleWinning,
      matches: sampleMatches, rank: lottoRank(sampleMatches), prize: lottoPrize(sampleMatches) });
  }

  function record(currency: 'gold' | 'score', amount: number, reason: string, now: Date) {
    if (!amount) return;
    ledger.unshift({ id: crypto.randomUUID(), currency, amount, reason, createdAt: now.toISOString() });
    if (currency === 'gold') gold += amount;
    else score += amount;
  }
  function settle(now: Date) {
    const today = kstDate(now);
    if (purchaseDate !== today) { purchaseDate = today; purchasedToday = 0; }
    if (now.getTime() >= drawAt(today) && !draws.has(today)) draws.set(today, drawNumbers());
    for (const ticket of lottoTickets) {
      if (ticket.prize !== null || now.getTime() < drawAt(ticket.drawDate)) continue;
      if (!draws.has(ticket.drawDate)) draws.set(ticket.drawDate, drawNumbers());
      const winning = draws.get(ticket.drawDate)!;
      ticket.winningNumbers = winning;
      ticket.matches = ticket.numbers.filter(number => winning.includes(number)).length;
      ticket.rank = lottoRank(ticket.matches);
      ticket.prize = lottoPrize(ticket.matches);
      record('gold', ticket.prize, `데일리 로또 ${ticket.rank}등`, now);
    }
  }
  function begin(now: Date) {
    settle(now);
    if (cells.every(cell => cell.buyerId !== null)) { boardId += 1; makeBoard(); draws_ = []; }
  }
  /** Free uses spent per item, keyed by KST date (counts reset each day). */
  const freeUsed = new Map<string, number>();
  const freeKey = (kind: DailyFreeKind, now: Date) => `${kstDate(now)}:${kind}`;
  const freeLeft = (kind: DailyFreeKind, now: Date) => Math.max(0, DAILY_FREE[kind] - (freeUsed.get(freeKey(kind, now)) ?? 0));
  function useFree(kind: DailyFreeKind, now: Date) {
    if (freeLeft(kind, now) < 1) throw new Error('오늘 무료 이용을 모두 썼어요.');
    freeUsed.set(freeKey(kind, now), (freeUsed.get(freeKey(kind, now)) ?? 0) + 1);
  }
  function state(now: Date): ShopState {
    return { gold, inventory: { ...inventory }, canPurchase: true, serverTime: now.toISOString(),
      free: { lotto: freeLeft('lotto', now), speetto: freeLeft('speetto', now), slot: freeLeft('slot', now), tag: freeLeft('tag', now) } };
  }
  function kuji(now: Date, purchase?: KujiPurchase): KujiResponse {
    const remainingByGrade = Object.fromEntries(KUJI_RULES.grades.map(rule => [rule.grade, 0])) as Record<KujiGrade, number>;
    for (const cell of cells) if (cell.buyerId === null) remainingByGrade[layout[cell.position]] += 1;
    return structuredClone({ ...state(now), kuji: { boardId, cells, remaining: cells.filter(cell => cell.buyerId === null).length,
      remainingByGrade, purchasedToday, nextPrice: kujiCost(purchasedToday, 1), recent: draws_.slice(0, KUJI_RULES.historyLimit) }, ...(purchase ? { purchase } : {}) });
  }
  function lotto(now: Date, purchase?: LottoTicket): LottoResponse {
    const today = kstDate(now);
    const cutoff = nextDate(today, -(SHOP_HISTORY_DAYS - 1));
    return structuredClone({ ...state(now), lotto: {
      targetDrawDate: now.getTime() < drawAt(today) ? today : nextDate(today),
      todayDraw: { date: today, numbers: draws.get(today) ?? null }, tickets: lottoTickets.filter(ticket => ticket.purchaseDate >= cutoff),
    }, ...(purchase ? { purchase } : {}) });
  }
  function speetto(now: Date, purchase?: SpeettoTicket): SpeettoResponse {
    const cutoff = nextDate(kstDate(now), -(SHOP_HISTORY_DAYS - 1));
    return structuredClone({ ...state(now), speetto: { tickets: speettoTickets.filter(ticket => ticket.purchaseDate >= cutoff) }, ...(purchase ? { purchase } : {}) });
  }
  function slot(now: Date, spin?: SlotSpin): SlotResponse {
    const cutoff = nextDate(kstDate(now), -(SHOP_HISTORY_DAYS - 1));
    const recent = slotSpins.filter(entry => entry.date >= cutoff)
      .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, SLOT_RULES.historyLimit);
    return structuredClone({ ...state(now), slot: { recent }, ...(spin ? { spin } : {}) });
  }
  function tagState(now: Date): NicknameTagState {
    const today = kstDate(now);
    const list = tags.filter(tag => !tag.discarded).sort((left, right) => Number(right.equipped) - Number(left.equipped)
      || GRADE_RANK[left.grade] - GRADE_RANK[right.grade] || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .map(({ date: _date, discarded: _discarded, ...tag }) => tag);
    return { tags: list, equipped: list.find(tag => tag.equipped) ?? null,
      drawsToday: tags.filter(tag => tag.date === today).length, dailyLimit: NICKNAME_TAG_RULES.dailyLimit, price: NICKNAME_TAG_RULES.price };
  }
  function tagResponse(now: Date, draw?: NicknameTag): TagResponse {
    return structuredClone({ ...state(now), tags: tagState(now), ...(draw ? { draw } : {}) });
  }
  function lottoNotice(now = new Date()): LottoNotice | null {
    settle(now);
    const today = kstDate(now);
    if (now.getTime() < drawAt(today)) return null;
    const tickets = lottoTickets.filter(ticket => ticket.drawDate === today);
    return tickets.length ? { drawDate: today, tickets: tickets.length,
      winners: tickets.filter(ticket => (ticket.prize ?? 0) > 0).length,
      prize: tickets.reduce((sum, ticket) => sum + (ticket.prize ?? 0), 0) } : null;
  }
  function replay(kind: ShopKind, requestId: string, payload: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error('구매 요청을 다시 시도해 주세요.');
    const previous = receipts.get(requestId);
    if (previous && (previous.kind !== kind || previous.payload !== payload)) throw new Error('다른 구매에 사용한 요청 번호예요. 다시 선택해 주세요.');
    return previous?.purchase;
  }
  function pay(payment: ShopPayment, item: keyof Inventory, price: number, reason: string, now: Date) {
    if (payment === 'ticket') {
      if (inventory[item] < 1) throw new Error('사용할 이용권이 없어요.');
      inventory[item] -= 1;
    } else if (payment === 'gold') {
      if (gold < price) throw new Error('골드가 부족해요.');
      record('gold', -price, reason, now);
    } else throw new Error('결제 방법을 확인해 주세요.');
  }
  function read(): ShopState;
  function read(kind: 'kuji'): KujiResponse;
  function read(kind: 'lotto'): LottoResponse;
  function read(kind: 'speetto'): SpeettoResponse;
  function read(kind: 'slot'): SlotResponse;
  function read(kind: 'tag'): TagResponse;
  function read(kind: ShopKind): KujiResponse | LottoResponse | SpeettoResponse | SlotResponse | TagResponse;
  function read(kind?: ShopKind): ShopState | KujiResponse | LottoResponse | SpeettoResponse | SlotResponse | TagResponse;
  function read(kind?: ShopKind): ShopState | KujiResponse | LottoResponse | SpeettoResponse | SlotResponse | TagResponse {
    const now = new Date();
    begin(now);
    return kind === 'kuji' ? kuji(now) : kind === 'lotto' ? lotto(now) : kind === 'speetto' ? speetto(now) : kind === 'slot' ? slot(now)
      : kind === 'tag' ? tagResponse(now) : state(now);
  }
  function buyKuji(input: KujiPurchaseInput): KujiResponse {
    const now = new Date();
    begin(now);
    const positions = [...input.positions].sort((a, b) => a - b);
    const payload = JSON.stringify({ boardId: input.boardId, positions });
    const previous = replay('kuji', input.requestId, payload);
    if (previous) return kuji(now, previous as KujiPurchase);
    if (!positions.length || positions.length > KUJI_RULES.size || new Set(positions).size !== positions.length ||
      positions.some(position => !Number.isInteger(position) || position < 0 || position >= KUJI_RULES.size)) throw new Error('살 쿠지를 다시 골라 주세요.');
    if (input.boardId !== boardId) throw new Error('새 쿠지판이 열렸어요. 다시 골라 주세요.');
    if (positions.some(position => cells[position].buyerId !== null)) throw new Error('이미 팔린 쿠지가 포함되어 있어요. 다시 골라 주세요.');
    const cost = kujiCost(purchasedToday, positions.length);
    if (gold < cost) throw new Error('골드가 부족해요.');
    const reward = { gold: 0, score: 0, lottoTickets: 0, speettoTickets: 0 };
    const won = positions.map(position => {
      const grade = layout[position];
      const rule = KUJI_RULES.grades.find(rule => rule.grade === grade)!;
      reward.gold += rule.gold;
      reward.score += rule.score;
      reward.lottoTickets += rule.lottoTickets;
      reward.speettoTickets += rule.speettoTickets;
      return { position, grade };
    });
    record('gold', -cost, `예굼쿠지 ${positions.length}장`, now);
    for (const cell of won) cells[cell.position] = { ...cell, buyerId: 'preview' };
    purchasedToday += positions.length;
    const lastOne = cells.every(cell => cell.buyerId !== null);
    record('gold', reward.gold, '예굼쿠지 보상', now);
    if (lastOne) { reward.gold += KUJI_RULES.lastOneGold; record('gold', KUJI_RULES.lastOneGold, '예굼쿠지 라스트원', now); }
    record('score', reward.score, '예굼쿠지 점수', now);
    inventory.lottoTickets += reward.lottoTickets;
    inventory.speettoTickets += reward.speettoTickets;
    const purchase: KujiPurchase = { requestId: input.requestId, boardId, cells: won, cost, reward, lastOne };
    draws_.unshift({ id: input.requestId, userId: 'preview', createdAt: now.toISOString(), cells: won, lastOne });
    receipts.set(input.requestId, { kind: 'kuji', payload, purchase });
    return kuji(now, purchase);
  }
  function buyLotto(input: LottoPurchaseInput): LottoResponse {
    const now = new Date();
    begin(now);
    const numbers = [...input.numbers].sort((a, b) => a - b);
    const payload = JSON.stringify({ numbers, payment: input.payment });
    const previous = replay('lotto', input.requestId, payload);
    if (previous) return lotto(now, previous as LottoTicket);
    if (numbers.length !== LOTTO_RULES.pickCount || new Set(numbers).size !== LOTTO_RULES.pickCount ||
      numbers.some(number => !Number.isInteger(number) || number < 1 || number > LOTTO_RULES.maxNumber)) throw new Error('서로 다른 숫자를 골라 주세요.');
    if (input.payment === 'free') useFree('lotto', now); else pay(input.payment, 'lottoTickets', LOTTO_RULES.price, '데일리 로또 구매', now);
    const today = kstDate(now);
    const purchase: LottoTicket = { id: crypto.randomUUID(), requestId: input.requestId,
      purchaseDate: today, createdAt: now.toISOString(),
      drawDate: now.getTime() < drawAt(today) ? today : nextDate(today), numbers, payment: input.payment,
      cost: input.payment === 'gold' ? LOTTO_RULES.price : 0, winningNumbers: null, matches: null, rank: null, prize: null };
    lottoTickets.unshift(purchase);
    receipts.set(input.requestId, { kind: 'lotto', payload, purchase });
    return lotto(now, purchase);
  }
  function buySpeetto(input: SpeettoPurchaseInput): SpeettoResponse {
    const now = new Date();
    begin(now);
    const payload = JSON.stringify({ payment: input.payment });
    const previous = replay('speetto', input.requestId, payload);
    if (previous) return speetto(now, previous as SpeettoTicket);
    if (input.payment === 'free') useFree('speetto', now); else pay(input.payment, 'speettoTickets', SPEETTO_RULES.price, '스피또 구매', now);
    const won = Math.random() * 100 < SPEETTO_RULES.winPercent;
    const symbols = shuffled(SPEETTO_RULES.characters);
    const resultCells: SpeettoSymbol[] = won ? [symbols[0], symbols[0], symbols[0]] : symbols.slice(0, 3);
    const purchase: SpeettoTicket = { id: crypto.randomUUID(), requestId: input.requestId, cells: resultCells, won,
      purchaseDate: kstDate(now),
      prize: won ? SPEETTO_RULES.prize : 0, payment: input.payment,
      cost: input.payment === 'gold' ? SPEETTO_RULES.price : 0, createdAt: now.toISOString() };
    record('gold', purchase.prize, '스피또 당첨', now);
    speettoTickets.unshift(purchase);
    receipts.set(input.requestId, { kind: 'speetto', payload, purchase });
    return speetto(now, purchase);
  }
  function spinSlot(input: SlotSpinInput): SlotResponse {
    const now = new Date();
    begin(now);
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) throw new Error('구매 요청을 다시 시도해 주세요.');
    const previous = slotReceipts.get(input.requestId);
    if (previous) return slot(now, previous);
    const free = freeLeft('slot', now) > 0;
    if (!free && gold < SLOT_RULES.price) throw new Error('골드가 부족해요');
    if (free) useFree('slot', now);
    const result = slotResult(max => Math.floor(Math.random() * max));
    const spin: SlotSpin = { id: crypto.randomUUID(), requestId: input.requestId, ...result,
      cost: free ? 0 : SLOT_RULES.price, date: kstDate(now), createdAt: now.toISOString(), free };
    if (!free) record('gold', -spin.cost, '슬롯머신', now);
    record('gold', spin.prize, '슬롯머신 당첨', now);
    slotSpins.unshift(spin);
    slotReceipts.set(input.requestId, spin);
    return slot(now, spin);
  }
  function drawTag(input: TagDrawInput): TagResponse {
    const now = new Date();
    begin(now);
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)) throw new Error('구매 요청을 다시 시도해 주세요.');
    const previous = tagReceipts.get(input.requestId);
    if (previous) { const { date: _date, ...draw } = previous; return tagResponse(now, draw); }
    const today = kstDate(now);
    if (tags.filter(tag => tag.date === today).length >= NICKNAME_TAG_RULES.dailyLimit) throw new Error(`별명 태그는 하루 ${NICKNAME_TAG_RULES.dailyLimit}번까지 뽑을 수 있어요.`);
    // A draw ticket pays before gold, as it does on the server.
    const payment: ShopPayment = freeLeft('tag', now) > 0 ? 'free' : inventory.tagTickets > 0 ? 'ticket' : 'gold';
    if (payment === 'gold' && gold < NICKNAME_TAG_RULES.price) throw new Error('골드가 부족해요');
    const tag = { id: crypto.randomUUID(), ...drawNicknameTag(max => Math.floor(Math.random() * max)), equipped: false, createdAt: now.toISOString(), date: today, payment };
    if (payment === 'free') useFree('tag', now); else pay(payment, 'tagTickets', NICKNAME_TAG_RULES.price, '별명 태그 뽑기', now);
    tags.push(tag);
    tagReceipts.set(input.requestId, tag);
    const { date: _date, ...draw } = tag;
    return tagResponse(now, draw);
  }
  function equipTag(tagId: string | null): TagResponse {
    const now = new Date();
    if (tagId !== null && !tags.some(tag => tag.id === tagId && !tag.discarded)) throw new Error('내가 모은 별명 태그가 아니에요.');
    for (const tag of tags) tag.equipped = tag.id === tagId;
    return tagResponse(now);
  }
  function discardTag(tagId: string): TagResponse {
    const now = new Date();
    const tag = tags.find(entry => entry.id === tagId && !entry.discarded);
    if (!tag) throw new Error('내가 모은 별명 태그가 아니에요.');
    if (tag.equipped) throw new Error('달고 있는 별명 태그는 먼저 떼고 버려 주세요.');
    tag.discarded = true;
    return tagResponse(now);
  }
  return { read, buyKuji, buyLotto, buySpeetto, spinSlot, drawTag, equipTag, discardTag, lottoNotice,
    get equippedTag() { const tag = tags.find(entry => entry.equipped); return tag ? { grade: tag.grade, text: tag.text } : null; },
    claimLaunchGift() {
      const now = new Date();
      if (kstDate(now) !== LAUNCH_GIFT.date) throw new Error('런칭 선물은 오픈 당일에만 받을 수 있어요.');
      if (attendanceDate !== LAUNCH_GIFT.date || attendanceBonus <= 0) throw new Error('오늘 출석 체크를 먼저 해 주세요.');
      const awarded = !launchGiftClaimed;
      if (awarded) {
        inventory.lottoTickets += LAUNCH_GIFT.lottoTickets;
        inventory.speettoTickets += LAUNCH_GIFT.speettoTickets;
        launchGiftClaimed = true;
      }
      return { state: state(now), awarded };
    },
    setGameGoldBonus(next: number) {
      gold += next - gameGoldBonus;
      gameGoldBonus = next;
    },
    // Attendance owns its preview record. Reconcile its rewards here so
    // claiming attendance after a purchase never resets or duplicates spending.
    setAttendanceBonus(next: number, date: string) {
      grantAttendanceTickets(next, date);
      if (date !== attendanceDate) { attendanceDate = date; attendanceBonus = 0; }
      // A new day may earn another reward; it must not revoke money already
      // received (and possibly spent) on the previous day.
      if (next > attendanceBonus) { gold += next - attendanceBonus; attendanceBonus = next; }
    },
    get ledger() { return structuredClone(ledger); },
    get score() { return score; },
  };
}
