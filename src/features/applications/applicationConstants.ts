import type { ApplicationStatus } from '@/services/api';

export const FUNNEL_STAGES: ApplicationStatus[] = ['saved', 'tailored', 'applied', 'interview', 'offer'];

export const TERMINAL_STAGES: ApplicationStatus[] = ['rejected', 'withdrawn', 'ghosted'];

export const ALL_APPLICATION_STATUSES: ApplicationStatus[] = [
  'saved', 'tailored', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted',
];

export const APPLICATION_EVENT_TYPES = [
  { value: 'note_added', label: 'Note' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'interview_scheduled', label: 'Interview' },
  { value: 'offer_received', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
] as const;

export type ApplicationStatusLabelMap = Record<ApplicationStatus, string>;
export type ApplicationStatusColorMap = Record<ApplicationStatus, string>;

export const STATUS_LABELS: ApplicationStatusLabelMap = {
  saved: 'Saved',
  tailored: 'Tailored',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  ghosted: 'Ghosted',
};

// Status is a flat dot + word on a neutral surface. These are text colours only.
export const STATUS_COLORS: ApplicationStatusColorMap = {
  saved: 'text-[hsl(var(--status-draft))]',
  tailored: 'text-[hsl(var(--status-sent))]',
  applied: 'text-[hsl(var(--status-sent))]',
  interview: 'text-[hsl(var(--status-interview))]',
  offer: 'text-[hsl(var(--status-offer))]',
  rejected: 'text-[hsl(var(--status-rejected))]',
  withdrawn: 'text-[hsl(var(--status-draft))]',
  ghosted: 'text-[hsl(var(--status-draft))]',
};
