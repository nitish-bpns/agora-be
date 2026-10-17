import { describe, expect, it } from 'vitest';
import { addBusinessDays, addMonths, businessDaysBetween } from '../src/common/dates.js';

describe('trading calendar', () => {
  it('skips weekends for T+N', () => expect(addBusinessDays('2026-10-16', 2)).toBe('2026-10-20'));
  it('rolls a T+0 weekend forward', () => expect(addBusinessDays('2026-10-17', 0)).toBe('2026-10-19'));
  it('clamps one month tenor to the last day', () => expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'));
  it('counts late business days', () => expect(businessDaysBetween('2026-10-16', '2026-10-20')).toBe(2));
});
