import type { CatalogueSalary } from '@/services/api/jobs';
import { formatSalary } from '@/features/jobs/salary';

export interface SalaryTextProps {
  salary: CatalogueSalary | null | undefined;
  className?: string;
}

/** Presentational salary text. Renders nothing when the range is absent. */
export function SalaryText({ salary, className = '' }: SalaryTextProps) {
  const text = formatSalary(salary);
  if (!text) return null;
  return <span className={`tabular-nums ${className}`.trim()}>{text}</span>;
}
