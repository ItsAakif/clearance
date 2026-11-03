// Salary display for catalogue rows. Pure formatting, no React.
//
// The backend only emits a conservative annual range with a currency, so a
// missing range is omitted entirely (never a "—" or "Salary not listed"
// placeholder in the row).

import type { CatalogueSalary, CatalogueSalaryCurrency } from '../../services/api/jobs';

const CURRENCY_SYMBOLS: Readonly<Record<CatalogueSalaryCurrency, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function compactSalaryAmount(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value >= 1_000_000) {
    const millions = Math.round(value / 100_000) / 10;
    return `${millions}m`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * `$120k–$150k`, or `$120k` when both bounds are equal. Returns `null` for an
 * absent range so callers can omit the element rather than render a blank.
 */
export function formatSalary(salary: CatalogueSalary | null | undefined): string | null {
  if (!salary) return null;
  const symbol = CURRENCY_SYMBOLS[salary.currency] ?? `${salary.currency} `;
  const min = `${symbol}${compactSalaryAmount(salary.min)}`;
  if (salary.min === salary.max) return min;
  return `${min}–${symbol}${compactSalaryAmount(salary.max)}`;
}
