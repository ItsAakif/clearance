// ApplicationWorkspace.tsx - the document-first application workspace.
//
// WHAT THIS PAGE IS. One tracked application, its resume as a real typesetter artifact, the
// posting it came from, the evidence-level match, notes and the event timeline. It is a
// workspace, not a form: the resume preview owns the page, and the right rail carries the two
// things a user does next.
//
// WHAT IT DOES NOT PRETEND TO HAVE. There is no cover-document model, no email model and no
// AI-refine endpoint in this build, so there is no Cover document tab, no Email tab and no chat
// panel. A quiet line says the refinement surface is not wired rather than showing a fake one.
//
// RESUME RESOLUTION. `Application` has no `resumeId` column. The only honest read path is the
// linked `TailoredResume.sourceResumeId` (exposed additively by `GET /applications/:id`); if a
// future schema adds `Application.resumeId`, it is read as a fallback. A missing resume, a
// resume with no revision, a gate refusal and a render failure are four different states.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format, addDays } from 'date-fns';
import {
  Download,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ApplicationTimeline } from '@/features/applications/ApplicationTimeline';
import { useApplicationResumePreview } from '@/features/applications/useApplicationResumePreview';
import { LevelCounters } from '@/features/match/LevelCounters';
import { NamedGaps } from '@/features/match/NamedGaps';
import { levelCounters } from '@/features/match/matchPresentation';
import { MarkdownText } from '@/features/jobs/MarkdownText';
import { facetValueLabel } from '@/features/jobs/catalogueParams';
import { formatSalary } from '@/features/jobs/salary';
import { PdfPages } from '@/features/studio/PdfPages';
import { DEFAULT_TEMPLATE_ID, STUDIO_TEMPLATES } from '@/features/studio/templates';
import { useResumes } from '@/hooks/useResumeApi';
import {
  applicationsQueryKey,
  useApplication,
  useApplicationEvents,
  useCreateApplicationEvent,
  useUpdateApplication,
  useUpdateApplicationEvent,
} from '@/hooks/useJobs';
import { toast } from '@/hooks/use-toast';
import { applicationsApi } from '@/services/api';
import { ALL_APPLICATION_STATUSES, STATUS_LABELS } from '@/features/applications/applicationConstants';
import type { Application, ApplicationJobListing, ApplicationStatus, UpdateApplicationEventInput } from '@/services/api';
import type { MatchGap } from '@/services/api/match';
import type { CatalogueSalary } from '@/services/api/jobs';

const STATUS_DOT: Record<ApplicationStatus, string> = {
  saved: 'bg-[hsl(var(--status-draft))]',
  tailored: 'bg-[hsl(var(--status-sent))]',
  applied: 'bg-[hsl(var(--status-sent))]',
  interview: 'bg-[hsl(var(--status-interview))]',
  offer: 'bg-[hsl(var(--status-offer))]',
  rejected: 'bg-[hsl(var(--status-rejected))]',
  withdrawn: 'bg-[hsl(var(--status-draft))]',
  ghosted: 'bg-[hsl(var(--status-draft))]',
};

function statusDotClass(status: ApplicationStatus): string {
  return STATUS_DOT[status] ?? STATUS_DOT.saved;
}

/** The catalogue row carries the salary; older rows may not have one. Omit, never invent. */
function listingSalary(listing: ApplicationJobListing | null | undefined): CatalogueSalary | null {
  const salary = listing?.searchDocument?.salary;
  if (!salary || typeof salary.min !== 'number' || typeof salary.max !== 'number') return null;
  const currency = salary.currency === 'EUR' || salary.currency === 'GBP' ? salary.currency : 'USD';
  return { min: salary.min, max: salary.max, currency };
}

/** The four match levels in report order, tolerating the raw `unknown[]` on the wire. */
function asMatchGaps(raw: unknown[] | null | undefined): MatchGap[] {
  return (raw ?? []).map((entry, index) => {
    const gap = (entry ?? {}) as Partial<MatchGap> & Record<string, unknown>;
    return {
      requirementId: String(gap.requirementId ?? `gap-${index}`),
      normalizedKey: String(gap.normalizedKey ?? ''),
      text: String(gap.text ?? gap.normalizedKey ?? 'Gap'),
      kind: String(gap.kind ?? 'gap'),
      importance: String(gap.importance ?? 'should'),
    };
  });
}

function fileSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'resume';
}

export default function ApplicationWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: app, isLoading } = useApplication(id ?? '');
  const updateApp = useUpdateApplication();
  const { data: events = [], isLoading: eventsLoading, error: eventsError, refetch } = useApplicationEvents(id ?? '');
  const addEvent = useCreateApplicationEvent();
  const updateEvent = useUpdateApplicationEvent();
  const { data: resumes = [] } = useResumes();

  const [notes, setNotes] = useState('');
  const [reminderDate, setReminderDate] = useState('');
  const [tab, setTab] = useState('resume');
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [choosingResume, setChoosingResume] = useState(false);
  const [selectedResumeId, setSelectedResumeId] = useState('');

  const deleteApp = useMutation({
    mutationFn: (applicationId: string) => applicationsApi.remove(applicationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: applicationsQueryKey });
      toast({ title: 'Application deleted' });
      navigate('/app/applications');
    },
    onError: (error: Error) => {
      toast({ title: 'Could not delete the application', description: error.message, variant: 'destructive' });
    },
  });

  // Step 1 of the resolution order. `Application` itself has no `resumeId`; the tailored
  // resume's `sourceResumeId` is the read path. The second branch is future-proofing for a
  // schema that adds the column - it is never assumed to exist today.
  const resumeId =
    app?.tailoredResume?.sourceResumeId ??
    (app as (Application & { resumeId?: string | null }) | undefined)?.resumeId ??
    null;
  const { state: preview, reload: reloadPreview, reportPageCount } = useApplicationResumePreview(resumeId, templateId);

  useEffect(() => {
    if (app) {
      setNotes(app.notes || '');
      setReminderDate(app.followUpAt?.slice(0, 10) || '');
    }
  }, [app]);

  const listing = app?.job ?? app?.jobListing ?? null;
  const match = app?.match ?? null;
  const gaps = useMemo(() => asMatchGaps(app?.matchGaps), [app?.matchGaps]);
  const salary = useMemo(() => listingSalary(listing), [listing]);
  const salaryLabel = useMemo(() => formatSalary(salary), [salary]);
  const workMode = listing?.searchDocument?.workMode
    ? facetValueLabel('workMode', listing.searchDocument.workMode)
    : null;

  const downloadPreview = useCallback(() => {
    if (preview.kind !== 'ready') return;
    const anchor = window.document.createElement('a');
    anchor.href = preview.objectUrl;
    anchor.download = `${fileSlug([listing?.title, listing?.company].filter(Boolean).join(' '))}-${preview.hash.slice(0, 8)}.pdf`;
    window.document.body.appendChild(anchor);
    anchor.click();
    window.document.body.removeChild(anchor);
  }, [listing?.company, listing?.title, preview]);

  if (isLoading || !app) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-ink-3" /></div>;
  }

  const handleNotesSave = () => {
    if (!id) return;
    updateApp.mutate({ id, notes });
  };

  const handleReminderSet = () => {
    if (!id) return;
    const iso = reminderDate ? new Date(`${reminderDate}T00:00:00`).toISOString() : null;
    updateApp.mutate({ id, followUpAt: iso });
    if (iso) {
      addEvent.mutate({ applicationId: id, type: 'follow_up', title: 'Follow-up reminder', scheduledAt: iso });
    }
  };

  const handleStatusChange = (status: ApplicationStatus) => {
    if (!id) return;
    updateApp.mutate({ id, status });
  };

  const handleDelete = () => {
    if (!id) return;
    if (!window.confirm('Delete this application? Its notes, events and match link will be removed. This cannot be undone.')) {
      return;
    }
    deleteApp.mutate(id);
  };

  const postingUrl = listing?.sourceUrl ?? listing?.applyUrl ?? null;
  const studioHref = resumeId ? `/app/studio/${resumeId}` : '/app/studio';
  const tailorHref = resumeId ? `/app/match/tailor/${resumeId}` : '/app/match/tailor';
  const canDownload = preview.kind === 'ready';
  const covered = match ? match.direct + match.contextual : 0;
  const coveredLine =
    match && match.total > 0 && covered === match.total
      ? `${covered} of ${match.total} requirements covered`
      : null;

  const nextActions: Array<{ label: string; run: () => void }> = [];
  if (app.status === 'saved' || app.status === 'tailored') {
    nextActions.push({
      label: 'Attach a resume',
      run: () => {
        setTab('resume');
        setChoosingResume(true);
      },
    });
    nextActions.push({ label: 'Tailor it', run: () => navigate(tailorHref) });
    nextActions.push({ label: 'Mark as sent', run: () => handleStatusChange('applied') });
  } else if (app.status === 'applied') {
    nextActions.push({
      label: 'Follow up in 5 days',
      run: () => {
        setReminderDate(format(addDays(new Date(), 5), 'yyyy-MM-dd'));
        setTab('notes');
      },
    });
    nextActions.push({ label: 'Log a reply', run: () => setTab('timeline') });
  } else if (app.status === 'interview') {
    nextActions.push({ label: 'Add interview date', run: () => setTab('timeline') });
  } else if (app.status === 'offer') {
    nextActions.push({ label: 'Record the offer', run: () => setTab('timeline') });
  }
  if (nextActions.length === 0) {
    nextActions.push({ label: 'Review the timeline', run: () => setTab('timeline') });
    nextActions.push({ label: 'Update the status', run: () => setTab('notes') });
  }

  const title = [listing?.title, listing?.company].filter(Boolean).join(' · ') || 'Application';

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-paper px-8 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink onClick={() => navigate('/app/applications')}>Applications</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="truncate">{title}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>

            <h1 className="page-title mt-2 break-words text-ink">{title}</h1>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
              {listing?.location ? <span>{listing.location}</span> : null}
              {workMode ? <span>{workMode}</span> : null}
              {salaryLabel ? <span className="tabular-nums">{salaryLabel}</span> : null}
              <span>
                {app.appliedAt
                  ? `Applied ${format(new Date(app.appliedAt), 'PP')}`
                  : `Created ${format(new Date(app.createdAt), 'PP')}`}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(app.status)}`} aria-hidden="true" />
                {STATUS_LABELS[app.status]}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {app.status === 'saved' || app.status === 'tailored' ? (
              <Button size="sm" onClick={() => handleStatusChange('applied')} disabled={updateApp.isPending}>
                Mark as sent
              </Button>
            ) : null}

            <Select value={app.status} onValueChange={(value) => handleStatusChange(value as ApplicationStatus)}>
              <SelectTrigger className="h-9 w-[150px]" aria-label="Application status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_APPLICATION_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex" tabIndex={canDownload ? undefined : 0}>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={downloadPreview}
                    disabled={!canDownload}
                    aria-label="Download PDF"
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Download PDF
                  </Button>
                </span>
              </TooltipTrigger>
              {!canDownload ? <TooltipContent>No rendered document yet.</TooltipContent> : null}
            </Tooltip>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-9 w-9" aria-label="More application actions">
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setTab('notes')}>
                  <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Edit notes and dates
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!postingUrl}
                  onSelect={() => {
                    if (postingUrl) window.open(postingUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <ExternalLink className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Open original posting
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={deleteApp.isPending}
                  onSelect={handleDelete}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Delete application
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-6 overflow-auto px-8 py-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList aria-label="Application sections">
              <TabsTrigger value="resume">Resume</TabsTrigger>
              <TabsTrigger value="posting">Job posting</TabsTrigger>
              <TabsTrigger value="match">Match</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>

            <TabsContent value="resume">
              {!resumeId ? (
                <section className="surface-card p-5">
                  <p className="text-sm font-medium text-ink">No resume attached to this application.</p>
                  <p className="mt-1 text-sm text-ink-3">
                    There is no resume linked to this record, so there is no document to render.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={() => setChoosingResume((value) => !value)}
                      className="text-sm text-primary underline-offset-4 hover:underline"
                    >
                      Choose a resume
                    </button>
                    <button
                      type="button"
                      onClick={() => navigate('/app/studio')}
                      className="text-sm text-ink-2 underline-offset-4 hover:underline"
                    >
                      Open Studio
                    </button>
                  </div>

                  {choosingResume ? (
                    <div className="mt-4 max-w-sm space-y-2">
                      {resumes.length === 0 ? (
                        <p className="text-sm text-ink-3">
                          You have no resumes yet. Create one from your career profile in Studio.
                        </p>
                      ) : (
                        <>
                          <label className="section-label block" htmlFor="application-resume">Choose a resume</label>
                          <Select value={selectedResumeId} onValueChange={setSelectedResumeId}>
                            <SelectTrigger id="application-resume">
                              <SelectValue placeholder="Select a resume" />
                            </SelectTrigger>
                            <SelectContent>
                              {resumes.map((resume) => (
                                <SelectItem key={resume.id} value={resume.id}>{resume.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {selectedResumeId ? (
                            <div className="space-y-2">
                              <p className="text-xs2 text-ink-3">
                                This build has no endpoint for attaching a resume to an application, so the
                                selection is not saved here. Open the resume in Studio to tailor and save it.
                              </p>
                              <Button size="sm" variant="outline" onClick={() => navigate(`/app/studio/${selectedResumeId}`)}>
                                Open in Studio
                              </Button>
                            </div>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </section>
              ) : (
                <section className="surface-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-3">
                      <span className="num tabular-nums">
                        {preview.kind === 'ready' && preview.pageCount > 0
                          ? `${preview.pageCount} page${preview.pageCount === 1 ? '' : 's'}`
                          : preview.kind === 'loading'
                            ? 'Rendering'
                            : 'Not rendered'}
                      </span>
                      <span className="h-4 w-px bg-rule" aria-hidden="true" />
                      <label htmlFor="resume-template" className="section-label">Template</label>
                      <Select value={templateId} onValueChange={setTemplateId}>
                        <SelectTrigger id="resume-template" className="h-8 w-[190px] text-[13px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STUDIO_TEMPLATES.map((template) => (
                            <SelectItem key={template.id} value={template.id}>{template.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={downloadPreview} disabled={!canDownload}>
                        <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        Download PDF
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => navigate(studioHref)}>
                        Open in Studio
                      </Button>
                    </div>
                  </div>

                  {preview.kind === 'loading' ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-ink-3">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Rendering the latest saved revision with the typesetter
                    </p>
                  ) : null}

                  {preview.kind === 'empty' ? (
                    <div className="rounded-control border border-rule bg-paper-2 p-5">
                      <p className="text-sm text-ink-2">{preview.message}</p>
                      <Button size="sm" variant="outline" className="mt-3" onClick={() => navigate(studioHref)}>
                        Open in Studio
                      </Button>
                    </div>
                  ) : null}

                  {preview.kind === 'refused' ? (
                    <Alert variant={preview.gate ? 'default' : 'destructive'}>
                      <AlertTitle>{preview.gate ? 'The pre-render gate refused this revision' : 'The resume could not be rendered'}</AlertTitle>
                      <AlertDescription className="space-y-1">
                        <p className="font-mono text-xs2 text-ink-2">{preview.code}</p>
                        {preview.reason ? <p className="font-mono text-xs2 text-ink-3">{preview.reason}</p> : null}
                        <p>{preview.message}</p>
                        {preview.gate ? (
                          <p>Confirm the statements on the Career Evidence page, then render again.</p>
                        ) : null}
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {preview.kind === 'ready' ? (
                    <PdfPages
                      bytes={preview.bytes}
                      fitWidth
                      zoom={1}
                      testId="application-resume-pages"
                      loadingLabel="Drawing the resume pages"
                      onPageCount={reportPageCount}
                      className="h-[70vh] max-h-[900px] min-h-[420px] rounded-control border border-rule"
                    />
                  ) : null}
                </section>
              )}
            </TabsContent>

            <TabsContent value="posting">
              <article className="surface-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="section-title">Job posting</h2>
                  {postingUrl ? (
                    <a
                      href={postingUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-sm text-ink-2 underline-offset-4 hover:underline"
                    >
                      Open original posting
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="text-xs2 text-ink-3">No original link on this listing.</span>
                  )}
                </div>
                <div className="mt-2 border-t border-rule" />
                {listing?.description ? (
                  <div className="mt-3">
                    <MarkdownText markdown={listing.description} />
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-ink-3">This listing has no description saved.</p>
                )}
              </article>
            </TabsContent>

            <TabsContent value="match">
              <div className="space-y-4">
                {match ? (
                  <LevelCounters counts={match} />
                ) : (
                  <div className="surface-card p-5">
                    <p className="text-sm text-ink-3">No match report for this job yet.</p>
                  </div>
                )}
                {match ? <NamedGaps gaps={gaps} /> : null}
                <div>
                  <button
                    type="button"
                    onClick={() => navigate(tailorHref)}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    Tailor this resume
                  </button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="notes">
              <div className="surface-card space-y-4 p-5">
                <div className="space-y-2">
                  <label className="section-label block" htmlFor="application-notes">Notes</label>
                  <Textarea
                    id="application-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    className="min-h-[120px]"
                  />
                  <Button size="sm" onClick={handleNotesSave} disabled={updateApp.isPending}>Save notes</Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="date"
                    className="w-40"
                    value={reminderDate}
                    onChange={(event) => setReminderDate(event.target.value)}
                    aria-label="Follow-up date"
                  />
                  <Button size="sm" variant="outline" onClick={handleReminderSet} disabled={!reminderDate}>
                    Set reminder
                  </Button>
                  {app.followUpAt ? (
                    <Button size="sm" variant="ghost" onClick={() => updateApp.mutate({ id: id!, followUpAt: null })}>
                      Clear
                    </Button>
                  ) : null}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="timeline">
              <div className="surface-card p-5">
                {eventsError ? (
                  <div className="space-y-2">
                    <p className="text-xs2 text-destructive">Failed to load events.</p>
                    <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
                  </div>
                ) : eventsLoading ? (
                  <div className="space-y-3">
                    <div className="h-12 w-full rounded-full bg-paper-2" />
                  </div>
                ) : (
                  <ApplicationTimeline
                    app={app}
                    events={events}
                    onAddEvent={(data) => addEvent.mutate({ applicationId: id!, ...data })}
                    onUpdateEvent={(eventId, data) => {
                      const payload = data as UpdateApplicationEventInput;
                      updateEvent.mutate({ applicationId: id!, eventId, ...payload });
                    }}
                    isSaving={addEvent.isPending || updateEvent.isPending}
                  />
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
          <section className="surface-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="section-title text-sm">Match</h2>
              <button
                type="button"
                onClick={() => setTab('match')}
                className="text-xs2 text-ink-3 underline-offset-4 hover:text-ink hover:underline"
              >
                Open
              </button>
            </div>
            {match ? (
              <>
                <dl className="mt-3 grid grid-cols-2 gap-2">
                  {levelCounters(match).map((counter) => (
                    <div key={counter.level}>
                      <dt className="text-xs2 text-ink-3">{counter.label}</dt>
                      <dd className="num text-lg tabular-nums text-ink">{counter.value}</dd>
                    </div>
                  ))}
                </dl>
                {coveredLine ? <p className="mt-3 text-xs2 text-ink-3">{coveredLine}</p> : null}
              </>
            ) : (
              <p className="mt-2 text-xs2 text-ink-3">No match report for this job yet.</p>
            )}
          </section>

          <section className="surface-card p-4">
            <h2 className="section-title text-sm">Next actions</h2>
            <div className="mt-2 flex flex-col items-start gap-2">
              {nextActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.run}
                  className="text-left text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                >
                  {action.label}
                </button>
              ))}
            </div>
          </section>

          <p className="px-1 text-xs2 text-ink-3">AI refinement is not wired here yet.</p>
        </aside>
      </div>
    </div>
  );
}
