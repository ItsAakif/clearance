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

export const STATUS_COLORS: ApplicationStatusColorMap = {
  saved: 'bg-secondary text-secondary-foreground',
  tailored: 'bg-primary/10 text-primary',
  applied: 'bg-blue-500/10 text-blue-500',
  interview: 'bg-amber-500/10 text-amber-500',
  offer: 'bg-success/10 text-success',
  rejected: 'bg-destructive/10 text-destructive',
  withdrawn: 'bg-muted text-muted-foreground',
  ghosted: 'bg-muted text-muted-foreground',
};
