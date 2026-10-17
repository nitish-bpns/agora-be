import { describe, expect, it } from 'vitest';
import { walkPositions } from '../src/modules/desk/position-engine.js';

describe('weighted-average position engine', () => {
  it('capitalizes opening charges and realizes a long close', () => {
    const result = walkPositions([
      { tradeId: '1', accountId: 'A', instrumentId: 'X', action: 'Buy', quantity: 10, price: 100, charges: 10, tradeDate: '2026-01-01' },
      { tradeId: '2', accountId: 'A', instrumentId: 'X', action: 'Sell', quantity: 4, price: 120, charges: 4, tradeDate: '2026-01-02' }
    ]);
    expect(result.positions[0]).toMatchObject({ quantity: 6, averageCost: 101, realizedPnl: 72, costBasis: 606 });
    expect(result.realizedTotal).toBe(72);
  });

  it('splits charges pro-rata when crossing through zero', () => {
    const result = walkPositions([
      { tradeId: '1', accountId: 'A', instrumentId: 'X', action: 'Buy', quantity: 10, price: 100, charges: 0 },
      { tradeId: '2', accountId: 'A', instrumentId: 'X', action: 'Sell', quantity: 15, price: 110, charges: 15 }
    ]);
    expect(result.positions[0]).toMatchObject({ quantity: -5, averageCost: 109, realizedPnl: 90, direction: 'Short' });
    expect(result.events[0]).toMatchObject({ closedQuantity: 10, openedQuantity: 5, chargesApplied: 10 });
  });

  it('keeps books for the same instrument isolated', () => {
    const result = walkPositions([
      { accountId: 'A', instrumentId: 'X', action: 'Buy', quantity: 1, price: 10 },
      { accountId: 'B', instrumentId: 'X', action: 'Buy', quantity: 1, price: 20 }
    ]);
    expect(result.positions).toHaveLength(2);
    expect(result.positions.map((item) => item.averageCost)).toEqual([10, 20]);
  });

  it('handles short covering and flat noise deterministically', () => {
    const result = walkPositions([
      { instrumentId: 'X', action: 'Sell', quantity: 3, price: 50, charges: 3 },
      { instrumentId: 'X', action: 'Buy', quantity: 3, price: 40, charges: 3 }
    ]);
    expect(result.positions[0]).toMatchObject({ quantity: 0, averageCost: 0, realizedPnl: 24, direction: 'Flat' });
  });
});
