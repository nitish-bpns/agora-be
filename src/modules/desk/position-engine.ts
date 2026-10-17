export const EPSILON = 1e-9;
export type Direction = 'Long' | 'Short' | 'Flat';
export interface AccountingTrade { tradeId?: string; accountId?: string; instrumentId: string; action: 'Buy' | 'Sell'; quantity: number; price: number; charges?: number; tradeDate?: string; createdAt?: Date; }
export interface Position { accountId: string; instrumentId: string; quantity: number; averageCost: number; costBasis: number; realizedPnl: number; chargesPaid: number; direction: Direction; isOpen: boolean; isLong: boolean; isShort: boolean; tradeCount: number; lastTradeDate?: string; openedOn?: string; }
interface State { quantity: number; averageCost: number; realizedPnl: number; chargesPaid: number; tradeCount: number; lastTradeDate: string | undefined; openedOn: string | undefined; }
const round = (value: number, digits = 6): number => Number(value.toFixed(digits));
const sign = (value: number): -1 | 0 | 1 => value > EPSILON ? 1 : value < -EPSILON ? -1 : 0;
const direction = (value: number): Direction => value > EPSILON ? 'Long' : value < -EPSILON ? 'Short' : 'Flat';

export function walkPositions(trades: AccountingTrade[]): { positions: Position[]; events: Record<string, unknown>[]; snapshots: Record<string, unknown>[]; realizedTotal: number } {
  const states = new Map<string, State>(); const events: Record<string, unknown>[] = []; const snapshots: Record<string, unknown>[] = [];
  for (const trade of trades) {
    const accountId = trade.accountId || 'ACC-LOCAL'; const key = `${accountId}\0${trade.instrumentId}`;
    const state = states.get(key) ?? { quantity: 0, averageCost: 0, realizedPnl: 0, chargesPaid: 0, tradeCount: 0, lastTradeDate: undefined, openedOn: undefined };
    const quantity = Number(trade.quantity || 0); const price = Number(trade.price || 0); const charges = Number(trade.charges || 0); const delta = trade.action === 'Buy' ? quantity : -quantity;
    state.tradeCount += 1; state.lastTradeDate = trade.tradeDate; state.chargesPaid += charges;
    let positionQuantity = state.quantity; let averageCost = state.averageCost; let event: Record<string, unknown> | undefined;
    if (Math.abs(delta) <= EPSILON) { /* validation prevents this; deliberately no position */ }
    else if (sign(positionQuantity) === 0) { averageCost = price + sign(delta) * charges / Math.abs(delta); positionQuantity = delta; state.openedOn = trade.tradeDate; }
    else if (sign(delta) === sign(positionQuantity)) {
      const existing = Math.abs(positionQuantity); const added = Math.abs(delta);
      averageCost = (existing * averageCost + added * price + sign(positionQuantity) * charges) / (existing + added); positionQuantity += delta; state.openedOn ??= trade.tradeDate;
    } else {
      const closed = Math.min(Math.abs(delta), Math.abs(positionQuantity)); const crossing = Math.abs(delta) > Math.abs(positionQuantity); const opened = crossing ? Math.abs(delta) - Math.abs(positionQuantity) : 0;
      const grossPnl = closed * sign(positionQuantity) * (price - averageCost); const chargesClosed = crossing ? charges * closed / Math.abs(delta) : charges; const chargesOpened = crossing ? charges * opened / Math.abs(delta) : 0; const realized = grossPnl - chargesClosed; state.realizedPnl += realized;
      event = { tradeId: trade.tradeId, accountId, instrumentId: trade.instrumentId, tradeDate: trade.tradeDate, action: trade.action, quantity: round(quantity), positionDirection: direction(positionQuantity), closedQuantity: round(closed), entryPrice: round(averageCost), exitPrice: round(price), grossPnl: round(grossPnl), chargesApplied: round(chargesClosed), realizedPnl: round(realized), openedQuantity: round(opened), openedPrice: opened ? round(price) : null };
      positionQuantity += delta;
      if (Math.abs(positionQuantity) <= EPSILON) { positionQuantity = 0; averageCost = 0; }
      else if (opened > 0) { averageCost = price + sign(delta) * chargesOpened / opened; state.openedOn = trade.tradeDate; }
    }
    state.quantity = Math.abs(positionQuantity) <= EPSILON ? 0 : positionQuantity; state.averageCost = averageCost; states.set(key, state); if (event) events.push(event);
    snapshots.push({ tradeId: trade.tradeId, accountId, instrumentId: trade.instrumentId, tradeDate: trade.tradeDate, action: trade.action, quantity: round(quantity), price: round(price), quantityAfter: round(state.quantity), averageCostAfter: round(state.averageCost), realizedAfter: round(state.realizedPnl) });
  }
  const positions = [...states.entries()].map(([key, state]): Position => { const [accountId = 'ACC-LOCAL', instrumentId = ''] = key.split('\0'); const dir = direction(state.quantity); return { accountId, instrumentId, quantity: round(state.quantity), averageCost: round(state.averageCost), costBasis: round(state.quantity * state.averageCost), realizedPnl: round(state.realizedPnl), chargesPaid: round(state.chargesPaid), direction: dir, isOpen: dir !== 'Flat', isLong: dir === 'Long', isShort: dir === 'Short', tradeCount: state.tradeCount, ...(state.lastTradeDate ? { lastTradeDate: state.lastTradeDate } : {}), ...(state.openedOn ? { openedOn: state.openedOn } : {}) }; });
  return { positions, events, snapshots, realizedTotal: round(positions.reduce((sum, item) => sum + item.realizedPnl, 0)) };
}
