import type { Application } from '@/services/api';

export interface ApplicationAnalytics {
  applications: number;
  interviews: number;
  offers: number;
  responseRate: number | null;
  averageMatchScore: number | null;
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

  const scores = apps
    .map((a) => a.jobListing?.match?.overallScore)
    .filter((s): s is number => typeof s === 'number' && !Number.isNaN(s));
  const averageMatchScore = scores.length === 0 ? null : Math.round((scores.reduce((sum, s) => sum + s, 0) / scores.length) * 10) / 10;

  return { applications, interviews, offers, responseRate, averageMatchScore };
}
