// T1101: `averageMatchScore` is GONE.
//
// It was the mean of `JobEvaluation.overallScore` across the pipeline - an average of a derived
// verdict, which is worse than one verdict: averaging a number the reader cannot audit hides the
// individual rows behind it. 06 sec. E.6 forbids the single number, and its arithmetic is exactly
// the "no client-side arithmetic over the counts" rule applied to a score instead of counts.
// The evaluation it averaged is still computed, still stored and still filters/sorts the job list.
//
// The four members that remain are all COUNTS of things that happened, or a rate over a
// denominator the reader can see, and none of them is derived from a quality score.
import type { Application } from '@/services/api';

export interface ApplicationAnalytics {
  applications: number;
  interviews: number;
  offers: number;
  responseRate: number | null;
}

export function computeApplicationAnalytics(apps: Application[]): ApplicationAnalytics {
  const applications = apps.length;
  const interviews = apps.filter((a) => a.status === 'interview' || a.status === 'offer').length;
  const offers = apps.filter((a) => a.status === 'offer').length;
  const denominator = apps.filter((a) =>
    ['applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'].includes(a.status) || !!a.appliedAt
  ).length;
  const responded = apps.filter((a) => ['interview', 'offer', 'rejected'].includes(a.status)).length;
  const responseRate = denominator === 0 ? null : Math.round((responded / denominator) * 1000) / 10;

  return { applications, interviews, offers, responseRate };
}
