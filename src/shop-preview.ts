import { KUJI_RULES, LOTTO_RULES, SPEETTO_RULES, kujiCost, lottoPrize, lottoRank } from '../shared/balance';
import type {
  Inventory, KujiCell, KujiGrade, KujiPurchase, KujiPurchaseInput, KujiResponse,
  LedgerEntry, LottoPurchaseInput, LottoResponse, LottoTicket, ShopKind, ShopPayment,
  ShopState, SpeettoPurchaseInput, SpeettoResponse, SpeettoSymbol, SpeettoTicket,
} from '../shared/types';

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
  const inventory: Inventory = { lottoTickets: 2, speettoTickets: 2 };
  const ledger: LedgerEntry[] = [];
  let boardId = 1;
  let layout: KujiGrade[] = [];
  let cells: KujiCell[] = [];
  let purchaseDate = kstDate(new Date());
  let purchasedToday = 4;
  const lottoTickets: LottoTicket[] = [];
  const speettoTickets: SpeettoTicket[] = [];
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

  // A published previous draw gives the result screen an example before the
  // visitor buys a ticket. Its historical prize is already in the sample gold.
  const yesterday = nextDate(purchaseDate, -1);
  const sampleWinning = [3, 7, 12, 18, 24];
  const sampleNumbers = [3, 7, 12, 18, 25];
  const sampleMatches = sampleNumbers.filter(number => sampleWinning.includes(number)).length;
  draws.set(yesterday, sampleWinning);
  lottoTickets.push({ id: 'preview-lotto-history', requestId: 'preview-lotto-history', drawDate: yesterday,
    numbers: sampleNumbers, payment: 'gold', cost: LOTTO_RULES.price, winningNumbers: sampleWinning,
    matches: sampleMatches, rank: lottoRank(sampleMatches), prize: lottoPrize(sampleMatches) });

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
    if (cells.every(cell => cell.buyerId !== null)) { boardId += 1; makeBoard(); }
  }
  function state(now: Date): ShopState {
    return { gold, inventory: { ...inventory }, canPurchase: true, serverTime: now.toISOString() };
  }
  function kuji(now: Date, purchase?: KujiPurchase): KujiResponse {
    const remainingByGrade = Object.fromEntries(KUJI_RULES.grades.map(rule => [rule.grade, 0])) as Record<KujiGrade, number>;
    for (const cell of cells) if (cell.buyerId === null) remainingByGrade[layout[cell.position]] += 1;
    return structuredClone({ ...state(now), kuji: { boardId, cells, remaining: cells.filter(cell => cell.buyerId === null).length,
      remainingByGrade, purchasedToday, nextPrice: kujiCost(purchasedToday, 1) }, ...(purchase ? { purchase } : {}) });
  }
  function lotto(now: Date, purchase?: LottoTicket): LottoResponse {
    const today = kstDate(now);
    return structuredClone({ ...state(now), lotto: {
      targetDrawDate: now.getTime() < drawAt(today) ? today : nextDate(today),
      todayDraw: { date: today, numbers: draws.get(today) ?? null }, tickets: lottoTickets,
    }, ...(purchase ? { purchase } : {}) });
  }
  function speetto(now: Date, purchase?: SpeettoTicket): SpeettoResponse {
    return structuredClone({ ...state(now), speetto: { tickets: speettoTickets }, ...(purchase ? { purchase } : {}) });
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
  function read(kind: ShopKind): KujiResponse | LottoResponse | SpeettoResponse;
  function read(kind?: ShopKind): ShopState | KujiResponse | LottoResponse | SpeettoResponse;
  function read(kind?: ShopKind): ShopState | KujiResponse | LottoResponse | SpeettoResponse {
    const now = new Date();
    begin(now);
    return kind === 'kuji' ? kuji(now) : kind === 'lotto' ? lotto(now) : kind === 'speetto' ? speetto(now) : state(now);
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
    pay(input.payment, 'lottoTickets', LOTTO_RULES.price, '데일리 로또 구매', now);
    const today = kstDate(now);
    const purchase: LottoTicket = { id: crypto.randomUUID(), requestId: input.requestId,
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
    pay(input.payment, 'speettoTickets', SPEETTO_RULES.price, '스피또 구매', now);
    const won = Math.random() * 100 < SPEETTO_RULES.winPercent;
    const symbols = shuffled(SPEETTO_RULES.characters);
    const resultCells: SpeettoSymbol[] = won ? [symbols[0], symbols[0], symbols[0]] : symbols.slice(0, 3);
    const purchase: SpeettoTicket = { id: crypto.randomUUID(), requestId: input.requestId, cells: resultCells, won,
      prize: won ? SPEETTO_RULES.prize : 0, payment: input.payment,
      cost: input.payment === 'gold' ? SPEETTO_RULES.price : 0, createdAt: now.toISOString() };
    record('gold', purchase.prize, '스피또 당첨', now);
    speettoTickets.unshift(purchase);
    receipts.set(input.requestId, { kind: 'speetto', payload, purchase });
    return speetto(now, purchase);
  }
  return { read, buyKuji, buyLotto, buySpeetto,
    setGameGoldBonus(next: number) {
      gold += next - gameGoldBonus;
      gameGoldBonus = next;
    },
    // Attendance owns its preview record. Only reconcile its cash here so
    // claiming attendance after a purchase never resets or duplicates spending.
    setAttendanceBonus(next: number, date: string) {
      if (date !== attendanceDate) { attendanceDate = date; attendanceBonus = 0; }
      // A new day may earn another reward; it must not revoke money already
      // received (and possibly spent) on the previous day.
      if (next > attendanceBonus) { gold += next - attendanceBonus; attendanceBonus = next; }
    },
    get ledger() { return structuredClone(ledger); },
    get score() { return score; },
  };
}
