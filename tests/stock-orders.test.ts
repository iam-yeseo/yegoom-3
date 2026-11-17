import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../src/api';
import { createStockOrders, type SendStockOrder } from '../src/stock-orders';
import { STOCK_ORDER_UNFILLED_CODES, type StockTradeInput, type StockTradeResponse } from '../shared/stock-types';

/** A browser storage that survives "reloads": new order books read the same map. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); } };
}
/** The server's side of the contract: one trade per (account, requestId). */
function fakeServer() {
  const trades = new Map<string, StockTradeInput>();
  const requests: StockTradeInput[] = [];
  const receipt = (input: StockTradeInput): StockTradeResponse => ({
    trade: { id: `trade-${input.requestId}`, requestId: input.requestId, ticker: input.ticker, side: input.side, quantity: input.quantity,
      price: 1500, fee: 15, total: 1515, costBasis: 1515, createdAt: '2026-11-05T01:00:00.000Z' },
    stock: { ticker: input.ticker, price: 1500, prevClose: 1500, dayOpen: 1500, dayHigh: 1500, dayLow: 1500, status: 'listed', halted: false,
      warningSince: null, delistedOn: null, relistOn: null, version: input.expectedVersion, held: input.quantity, costBasis: 1515 },
    gold: 0, replayed: false,
  });
  /** Fill once; `lose` drops the answer after the trade is stored. */
  const send = (lose = false): SendStockOrder => async input => {
    requests.push(input);
    const key = `${input.expectedUserId}:${input.requestId}`;
    if (!trades.has(key)) trades.set(key, input);
    if (lose) throw new ApiFailure(0, '연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
    return receipt(input);
  };
  const refuse = (status: number, code: string): SendStockOrder => async input => {
    requests.push(input);
    throw new ApiFailure(status, `${code} 안내`, code);
  };
  return { trades, requests, send, refuse };
}
const order = (requestId = 'order-1'): StockTradeInput => ({ requestId, ticker: 'YKHX', side: 'buy', quantity: 10, expectedVersion: 7 });

describe('stock orders awaiting their result', () => {
  it('saves the whole order before sending and forgets it once its receipt arrives', async () => {
    const storage = memoryStorage();
    const orders = createStockOrders(storage);
    const server = fakeServer();
    let savedWhileSending: string | null = null;
    const outcome = await orders.submit('min', order(), async input => {
      savedWhileSending = storage.getItem('yegoom3:stock:order:min');
      return server.send()(input);
    });
    expect(JSON.parse(savedWhileSending!)).toMatchObject({ input: { requestId: 'order-1', ticker: 'YKHX', side: 'buy', quantity: 10, expectedVersion: 7, expectedUserId: 'min' } });
    expect(outcome).toMatchObject({ status: 'filled', result: { trade: { requestId: 'order-1' } } });
    expect(orders.pending('min')).toBeNull();
    expect(storage.items.size).toBe(0);
  });

  it('keeps an order whose answer was lost and fills it once when the same order is asked again', async () => {
    const storage = memoryStorage();
    const orders = createStockOrders(storage);
    const server = fakeServer();
    // The server stored the trade; only the answer went missing.
    expect(await orders.submit('min', order(), server.send(true))).toMatchObject({ status: 'unknown' });
    expect(server.trades.size).toBe(1);
    expect(orders.pending('min')?.input).toMatchObject({ requestId: 'order-1', quantity: 10, expectedVersion: 7 });
    // No other order leaves while this one is unsettled.
    expect(await orders.submit('min', order('order-2'), server.send())).toMatchObject({ status: 'blocked' });
    expect(server.requests).toHaveLength(1);
    // Asking again sends the saved id and input, and the single trade settles it.
    expect(await orders.recheck('min', server.send())).toMatchObject({ status: 'filled', result: { trade: { requestId: 'order-1', quantity: 10 } } });
    expect(server.requests[1]).toEqual(server.requests[0]);
    expect(server.trades.size).toBe(1);
    expect(orders.pending('min')).toBeNull();
    // Only now may a new order (a new id) go out.
    expect(await orders.submit('min', order('order-2'), server.send())).toMatchObject({ status: 'filled' });
    expect([...server.trades.keys()]).toEqual(['min:order-1', 'min:order-2']);
  });

  it('recovers the order after a reload and never applies it to another account', async () => {
    const storage = memoryStorage();
    const server = fakeServer();
    expect(await createStockOrders(storage).submit('min', order(), server.send(true))).toMatchObject({ status: 'unknown' });
    // A reload: a new order book over the same browser storage.
    const reloaded = createStockOrders(storage);
    expect(reloaded.pending('siwon')).toBeNull();
    expect(await reloaded.recheck('siwon', server.send())).toBeNull();
    expect(await reloaded.submit('siwon', order('siwon-1'), server.send())).toMatchObject({ status: 'filled' });
    // min's order is still waiting, untouched by siwon's session, and is sent as min's.
    expect(reloaded.pending('min')?.input).toMatchObject({ requestId: 'order-1', expectedUserId: 'min' });
    expect(await reloaded.recheck('min', server.send())).toMatchObject({ status: 'filled', result: { trade: { requestId: 'order-1' } } });
    expect(server.requests.map(request => `${request.expectedUserId}:${request.requestId}`)).toEqual(['min:order-1', 'siwon:siwon-1', 'min:order-1']);
    expect([...server.trades.keys()].sort()).toEqual(['min:order-1', 'siwon:siwon-1']);
  });

  it('settles on a confirmed refusal and lets a new order follow', async () => {
    for (const code of STOCK_ORDER_UNFILLED_CODES) {
      const orders = createStockOrders(memoryStorage());
      const server = fakeServer();
      expect(await orders.submit('min', order(), server.refuse(code.startsWith('INVALID') || code === 'UNKNOWN_STOCK' ? 400 : 409, code)), code)
        .toMatchObject({ status: 'rejected', code, message: `${code} 안내` });
      expect(orders.pending('min'), code).toBeNull();
      expect(await orders.submit('min', order('order-2'), server.send()), code).toMatchObject({ status: 'filled' });
    }
  });

  it('does not take other 4xx answers, server errors or lost connections for "not filled"', async () => {
    const unproven: [number, string][] = [[401, 'UNAUTHENTICATED'], [403, 'CANNOT_TRADE'], [403, 'ORIGIN_REJECTED'], [409, 'ACCOUNT_CHANGED'],
      [409, 'SOME_FUTURE_CODE'], [429, 'TOO_MANY_ATTEMPTS'], [500, 'INTERNAL_ERROR'], [503, 'STOCK_UNAVAILABLE']];
    for (const [status, code] of unproven) {
      const orders = createStockOrders(memoryStorage());
      const server = fakeServer();
      expect(await orders.submit('min', order(), server.refuse(status, code)), code).toMatchObject({ status: 'unknown', code });
      expect(orders.pending('min')?.input.requestId, code).toBe('order-1');
      // The same order is asked again, and a confirmed refusal still ends it.
      expect(await orders.recheck('min', server.refuse(status, code)), code).toMatchObject({ status: 'unknown' });
      expect(await orders.recheck('min', server.refuse(409, 'PRICE_CHANGED')), code).toMatchObject({ status: 'rejected', code: 'PRICE_CHANGED' });
      expect(orders.pending('min'), code).toBeNull();
    }
  });

  it('drops an order that never left the device, but keeps a pending one while offline', async () => {
    const offline: SendStockOrder = async () => { throw new ApiFailure(0, '인터넷 연결을 확인해 주세요. 입력한 내용은 아직 저장되지 않았어요.', 'OFFLINE'); };
    const orders = createStockOrders(memoryStorage());
    const server = fakeServer();
    // Offline at the first send: nothing was sent, so nothing can have filled.
    expect(await orders.submit('min', order(), offline)).toMatchObject({ status: 'rejected' });
    expect(orders.pending('min')).toBeNull();
    // Offline while an earlier send is unresolved: that proves nothing.
    expect(await orders.submit('min', order(), server.send(true))).toMatchObject({ status: 'unknown' });
    expect(await orders.recheck('min', offline)).toMatchObject({ status: 'unknown' });
    expect(orders.pending('min')?.input.requestId).toBe('order-1');
  });

  it('shares one request between simultaneous re-checks and tells listeners when it starts and ends', async () => {
    const orders = createStockOrders(memoryStorage());
    const server = fakeServer();
    await orders.submit('min', order(), server.send(true));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let notified = 0;
    const stop = orders.subscribe(() => { notified++; });
    const slow: SendStockOrder = async input => { await gate; return server.send()(input); };
    const first = orders.recheck('min', slow);
    const second = orders.recheck('min', slow);
    expect(orders.checking('min')).toBe(true);
    release();
    expect(await first).toBe(await second);
    expect(orders.checking('min')).toBe(false);
    expect(server.requests).toHaveLength(2); // the lost send and one re-check
    expect(notified).toBe(2);
    stop();
  });

  it('ignores a damaged saved order, an answer for another order, and works without storage', async () => {
    const damaged = createStockOrders(memoryStorage({
      'yegoom3:stock:order:min': '{"input":{"requestId":"x","ticker":"NOPE","side":"buy","quantity":1,"expectedVersion":1},"createdAt":"t"}',
      'yegoom3:stock:order:siwon': 'not json',
    }));
    expect(damaged.pending('min')).toBeNull();
    expect(damaged.pending('siwon')).toBeNull();
    const orders = createStockOrders(null);
    const server = fakeServer();
    // A receipt for some other request must not settle this order.
    expect(await orders.submit('preview', order(), async input => server.send()({ ...input, requestId: 'someone-else' }))).toMatchObject({ status: 'unknown' });
    expect(orders.pending('preview')?.input.requestId).toBe('order-1');
    expect(await orders.recheck('preview', server.send())).toMatchObject({ status: 'filled' });
    // Another tab settled it: the saved copy is read again.
    const storage = memoryStorage();
    const tab = createStockOrders(storage);
    await tab.submit('min', order(), server.send(true));
    storage.removeItem('yegoom3:stock:order:min');
    tab.reload('min');
    expect(tab.pending('min')).toBeNull();
  });
});
