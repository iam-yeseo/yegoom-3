import type { Inventory } from '../shared/types';

export interface UserBalances { gold: number; inventory: Inventory }

/** Missing rows represent untouched wallets; reads never create cache rows. */
export async function readBalances(db: D1Database, userId: string): Promise<UserBalances> {
  const row = await db.prepare(`SELECT gold, lotto_tickets AS lottoTickets, speetto_tickets AS speettoTickets
    FROM user_balances WHERE user_id = ?`).bind(userId).first<Inventory & { gold: number }>();
  return { gold: row?.gold ?? 0,
    inventory: { lottoTickets: row?.lottoTickets ?? 0, speettoTickets: row?.speettoTickets ?? 0 } };
}
