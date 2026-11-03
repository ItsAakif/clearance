// T1101: the "Avg. match score" tile is GONE with `averageMatchScore`. Four tiles remain, and the
// grid goes from five columns to four - a tile that always renders "-" is worse than no tile.
import { computeApplicationAnalytics } from './applicationAnalyticsData';
import type { Application } from '@/services/api';

interface Props {
  apps: Application[];
}

/**
 * Analytics is a ruled section with its own label. When there is nothing to
 * show it renders nothing at all: a label over an empty grid is worse than
 * absence.
 */
export function ApplicationAnalytics({ apps }: Props) {
  const data = computeApplicationAnalytics(apps);

  const metrics = [
    { label: 'Applications', value: data.applications },
    { label: 'Interviews', value: data.interviews },
    { label: 'Offers', value: data.offers },
    { label: 'Response rate', value: data.responseRate === null ? '-' : `${data.responseRate}%` },
  ];

  if (metrics.every((metric) => metric.value === 0 || metric.value === '-')) return null;

  return (
    <section className="surface-card p-5">
      <h2 className="section-title">Analytics</h2>
      <div className="mt-2 border-t border-border" />
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 pt-3 lg:grid-cols-4">
        {metrics.map((m) => (
          <div key={m.label}>
            <span className="section-label">{m.label}</span>
            <p className="num mt-1 text-2xl font-medium text-ink">{m.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
