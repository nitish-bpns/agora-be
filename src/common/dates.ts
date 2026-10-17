export function isoDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function addBusinessDays(value: string, days: number): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  let remaining = Math.max(0, Math.trunc(days));
  while (true) {
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && remaining <= 0) return isoDate(date);
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining -= 1;
  }
}

export function addMonths(value: string, months: number): string {
  const source = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  const day = source.getUTCDate();
  source.setUTCDate(1);
  source.setUTCMonth(source.getUTCMonth() + months + 1, 0);
  const last = source.getUTCDate();
  source.setUTCDate(Math.min(day, last));
  return isoDate(source);
}

export function businessDaysBetween(start: string, end: string): number {
  const first = new Date(`${start.slice(0, 10)}T00:00:00.000Z`);
  const last = new Date(`${end.slice(0, 10)}T00:00:00.000Z`);
  const step = last >= first ? 1 : -1;
  let count = 0;
  while (first.getTime() !== last.getTime()) {
    first.setUTCDate(first.getUTCDate() + step);
    if (first.getUTCDay() !== 0 && first.getUTCDay() !== 6) count += step;
  }
  return count;
}
