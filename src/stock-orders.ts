import { STOCK_RULES, isTicker } from "../shared/stocks";
import { STOCK_ORDER_UNFILLED_CODES, type StockTradeInput, type StockTradeResponse } from "../shared/stock-types";
import { ApiFailure, notSent } from "./api";

/** An order whose result this device has not seen yet. It is written down
 * before it is sent and kept until the server answers for exactly this
 * requestId, so asking again can never place a second order. */
export interface PendingStockOrder { input: StockTradeInput; createdAt: string }
export type StockOrderOutcome =
  /** The order's trade exists once on the server. */
  | { status: "filled"; result: StockTradeResponse }
  /** The server confirmed that the order did not fill. A new order may follow. */
  | { status: "rejected"; message: string; code?: string }
  /** Nobody knows yet: the order stays pending and is asked again as it was. */
  | { status: "unknown"; message: string; code?: string }
  /** Not sent: an earlier order of this account still awaits its result. */
  | { status: "blocked"; message: string };
export type SendStockOrder = (input: StockTradeInput) => Promise<StockTradeResponse>;
type OrderStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const UNKNOWN_MESSAGE = "주문 결과를 확인하지 못했어요. 같은 주문으로 다시 확인해 주세요.";
const OFFLINE_MESSAGE = "인터넷에 연결되면 같은 주문으로 결과를 다시 확인해 주세요.";
const storageKey = (account: string) => `yegoom3:stock:order:${account}`;

function validOrder(value: unknown): value is PendingStockOrder {
  const order = value as PendingStockOrder | null;
  const input = order?.input;
  return !!input && typeof order.createdAt === "string"
    && typeof input.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)
    && isTicker(input.ticker) && (input.side === "buy" || input.side === "sell")
    && Number.isInteger(input.quantity) && input.quantity >= 1 && input.quantity <= STOCK_RULES.maxOrder
    && Number.isSafeInteger(input.expectedVersion) && input.expectedVersion >= 0;
}

/** Orders in flight or awaiting their result, one per account. The saved copy
 * carries the whole input (stock, side, quantity, price version): a retry is
 * the same order or nothing. `storage` is null where nothing may be kept (the
 * serverless preview); the order then lives only as long as the page. */
export function createStockOrders(storage: OrderStorage | null) {
  const memory = new Map<string, PendingStockOrder>();
  const inFlight = new Map<string, Promise<StockOrderOutcome>>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());

  function pending(account: string): PendingStockOrder | null {
    const kept = memory.get(account);
    if (kept) return kept;
    try {
      const saved: unknown = JSON.parse(storage?.getItem(storageKey(account)) ?? "null");
      if (!validOrder(saved)) return null;
      // The owner travels with the order: it is only ever sent for this account.
      const order = { input: { ...saved.input, expectedUserId: account }, createdAt: saved.createdAt };
      memory.set(account, order);
      return order;
    } catch { return null; }
  }
  function keep(account: string, order: PendingStockOrder) {
    memory.set(account, order);
    try { storage?.setItem(storageKey(account), JSON.stringify(order)); } catch { /* Kept in memory until the page goes away. */ }
  }
  /** Forget an order once its own answer arrived; never a newer one. */
  function settle(account: string, requestId: string) {
    if (pending(account)?.input.requestId !== requestId) return;
    memory.delete(account);
    try { storage?.removeItem(storageKey(account)); } catch { /* Nothing was stored. */ }
  }

  function run(account: string, order: PendingStockOrder, send: SendStockOrder, first: boolean): Promise<StockOrderOutcome> {
    const attempt = (async (): Promise<StockOrderOutcome> => {
      try {
        const result = await send(order.input);
        // Only this order's own receipt settles it.
        if (result?.trade?.requestId !== order.input.requestId) return { status: "unknown", message: UNKNOWN_MESSAGE };
        settle(account, order.input.requestId);
        return { status: "filled", result };
      } catch (error) {
        const failure = error instanceof ApiFailure ? error : null;
        const message = error instanceof Error && error.message ? error.message : UNKNOWN_MESSAGE;
        // Offline before the first send: the order never left this device.
        if ((failure?.code && STOCK_ORDER_UNFILLED_CODES.includes(failure.code)) || (first && notSent(error))) {
          settle(account, order.input.requestId);
          return { status: "rejected", message, code: failure?.code };
        }
        // A refusal that proves nothing keeps its own wording (a new sign-in, for one).
        const explained = failure && failure.status >= 400 && failure.status < 500;
        return { status: "unknown", message: explained ? message : notSent(error) ? OFFLINE_MESSAGE : UNKNOWN_MESSAGE, code: failure?.code };
      }
    })().finally(() => { inFlight.delete(account); emit(); });
    inFlight.set(account, attempt);
    emit();
    return attempt;
  }

  return {
    pending,
    /** True while this account's order is on its way to the server. */
    checking: (account: string) => inFlight.has(account),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Another tab changed the saved order: read it again. */
    reload(account: string) { if (!inFlight.has(account)) { memory.delete(account); emit(); } },
    /** Send a new order. Refused while an earlier one still awaits its result. */
    submit(account: string, input: StockTradeInput, send: SendStockOrder): Promise<StockOrderOutcome> {
      if (pending(account) || inFlight.has(account)) return Promise.resolve({ status: "blocked", message: "이전 주문 결과를 먼저 확인해 주세요." });
      const order = { input: { ...input, expectedUserId: account }, createdAt: new Date().toISOString() };
      keep(account, order);
      return run(account, order, send, true);
    },
    /** Ask again with the saved requestId and input; null when nothing is pending. */
    recheck(account: string, send: SendStockOrder): Promise<StockOrderOutcome | null> {
      const active = inFlight.get(account);
      if (active) return active;
      const order = pending(account);
      return order ? run(account, order, send, false) : Promise.resolve(null);
    },
  };
}
export type StockOrders = ReturnType<typeof createStockOrders>;

function browserStorage(): OrderStorage | null {
  // localStorage: an order outlives a closed tab or app, where its result may still be unknown.
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
/** This device's orders against the real server. */
export const stockOrders = createStockOrders(browserStorage());
/** The preview keeps nothing: its market lives and dies with the page. */
export const previewStockOrders = createStockOrders(null);
