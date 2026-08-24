# Job Search UX implementation specification

## OBJECTIVE

Transform the current `/app/jobs` search results page from a grid of evaluate-only cards into an accessible job-discovery workspace: a filterable, keyboard-navigable list on the left and the selected job's complete description, fit analysis, and next actions on the right. Preserve the existing Clearance visual theme and existing job, evaluation, tailoring, board, saved-search, and application APIs. On narrow screens the list and detail become two sequential full-screen views, with filters in a sheet/drawer and no horizontal scrolling.

This is a frontend change. Do not add a database migration or backend endpoint. The current API returns only the fields documented below; optional UI fields must degrade gracefully when the backend does not provide them.

## VERIFIED

Inspected:

- `src/pages/Jobs.tsx`: search is mutation-based, currently stores `JobListingSummary[]` locally, has source/location/company controls (location/company are not sent to `jobsApi.search`), board scan, `BoardManager`, and `SavedSearchManager`.
- `src/pages/JobDetail.tsx`: fetches `jobsApi.get(id)`, evaluates with a selected resume, saves by creating an application with status `saved`, renders `JobEvaluationReport` and `TailorPanel`.
- `src/features/jobs/JobCard.tsx`: card currently has title/company/location/source, posting link, closed warning, and Evaluate action.
- `src/features/jobs/JobEvaluationReport.tsx`: current `JobEvaluation` has 0-5 scores for `cvMatch`, `levelFit`, `compFit`, `personalization`, `interviewPrep`, and `legitimacy`; arbitrary `reportJson` already contains interview bullets/red flags in existing code.
- `src/features/jobs/TailorPanel.tsx`: reusable template selector and `useTailorResume` integration.
- `src/hooks/useJobs.ts`: existing hooks include search, evaluate, create/update application, resumes are in `src/hooks/useResumeApi.ts`.
- `src/services/api/jobs.ts`: `JobListingSummary` has `id`, `source`, `title`, `company`, optional `location`, `applyUrl`, `postedAt`, and `isActive`; `jobsApi.get` adds `description`; there is no saved flag, skills, work mode, or evaluation-by-job query.
- `src/components/layout/AppLayout.tsx`: owns global shell and already sets `main` to `overflow-hidden`; do not change it.
- `src/App.tsx`: `/app/jobs` and `/app/jobs/:id` are already protected routes; no route change is required.
- shadcn primitives available in `src/components/ui`: `Sheet`, `Drawer`, `Select`, `Slider`, `Checkbox`, `Badge`, `Progress`, `Skeleton`, `ScrollArea`, `Dialog`, `Alert`, `Tooltip`, and `Tabs`.
- `package.json`: verification commands are `npm run lint` and `npm run build`; there is no frontend test script or frontend test suite.

Assumptions intentionally made: filtering and sorting are client-side because the current search service only accepts `q` and `sources`; match score, skills, work mode, and breakdown values are optional and must be read only when present in API data or evaluation `reportJson`. Do not fabricate scores or skills.

## ARCHITECTURE DECISIONS

1. **`JobsPage` is the workspace controller.** It owns query/filter/sort state, result state, selected job id, mobile detail state, and keyboard shortcuts. Child components are presentational or action adapters. This avoids two independent pages competing for selection and makes `j/k` deterministic.
2. **Keep `/app/jobs/:id` as a compatibility route.** Desktop selection uses `navigate('/app/jobs/' + id)` so refresh/deep links work. `JobDetailPage` becomes a wrapper around the shared `JobDetailPanel`, with a back control and no duplicated evaluation/tailoring logic. `/app/jobs` renders the two-pane workspace and selects the route id if present, otherwise the first result only after results exist.
3. **Do not modify `AppLayout` or global theme CSS.** Use existing semantic colors (`bg-card`, `text-muted-foreground`, `border-border`, `text-primary`, `bg-success`, etc.) and existing shadcn components.
4. **Use `Sheet` for filters.** It is already used successfully in this repository and has Radix focus trapping, labelled title, overlay, Escape close, and focus restoration. Use `side="left"` on mobile. Do not build a custom fixed drawer.
5. **Use applications as the existing save/tracking model.** A job is saved when an application for its listing exists. The list of applications is loaded once through `useApplications`; Save calls `useCreateApplication({ jobListingId, status: 'saved' })`; Track Application saves if needed and then navigates to `/app/applications`. Do not add a new save API or local-only saved state.
6. **Normalize untrusted optional evaluation data in one helper.** The backend's current evaluation contract does not name skills/experience/keywords/seniority or skill gaps. Add a typed normalization helper that checks known optional keys in `reportJson`, clamps numeric values to 0-100 or 0-5 as appropriate, and returns `undefined` for absent data. Components must not use `any` to reach into `reportJson`.
7. **No automatic evaluation on selection.** Selecting a job fetches its description, but analysis remains an explicit action. This avoids surprise LLM calls, respects BYOK failure behavior, and preserves the current workflow.

Rejected alternatives:

- A CSS-only grid transformation was rejected because it cannot provide persistent detail, URL/deep-link state, mobile navigation, or reliable shortcuts.
- Adding backend search parameters was rejected for this slice because there is no verified backend contract for the requested filters. The service can be extended later without changing the component contracts.
- Replacing `JobEvaluationReport` or `TailorPanel` wholesale was rejected; preserve and adapt them to avoid breaking existing evaluation and resume-tailoring behavior.

## STEPS

### 1. Add shared job workspace contracts and data helpers (independent)

Modify `src/services/api/jobs.ts` in the types section:

- Extend `JobListingSummary` with optional fields only:

```ts
  skills?: string[];
  workMode?: 'remote' | 'hybrid' | 'onsite' | string;
  employmentType?: string;
```

- Add:

```ts
export type JobSort = 'relevance' | 'matchScore' | 'newest';
export type JobWorkMode = 'all' | 'remote' | 'hybrid' | 'onsite';
export interface JobSearchFilters {
  query: string;
  minMatchScore?: number;
  location?: string;
  company?: string;
  workMode: JobWorkMode;
  sources: string[];
  postedWithin: 'all' | 'day' | 'week' | 'month';
  sortBy: JobSort;
}
export interface JobMatchBreakdown {
  skills?: number;
  experience?: number;
  keywords?: number;
  seniority?: number;
}
export interface NormalizedJobInsights {
  keySkills: string[];
  skillGaps: string[];
  breakdown: JobMatchBreakdown;
  evaluationResults: string[];
}
```

Do not change existing endpoint URLs or required fields. Add optional `description?: string` to a shared detail type only if useful, but retain `jobsApi.get(id)` returning the current summary-plus-description shape. Export new types from `src/services/api/index.ts`.

Create `src/features/jobs/jobSearchUtils.ts` with these exact exports:

```ts
export function getJobSkills(job: JobListingSummary): string[];
export function getJobWorkMode(job: JobListingSummary): JobWorkMode;
export function getPostedLabel(postedAt?: string): string;
export function isPostedWithin(postedAt: string | undefined, range: JobSearchFilters['postedWithin']): boolean;
export function filterAndSortJobs(jobs: JobListingSummary[], filters: JobSearchFilters, evaluatedScores: Record<string, number>): JobListingSummary[];
export function normalizeJobInsights(evaluation?: JobEvaluation | null): NormalizedJobInsights;
export function isTypingTarget(target: EventTarget | null): boolean;
```

Implementation rules: `getJobSkills` returns `job.skills ?? []`; never derive fake skills from description. `getJobWorkMode` uses explicit `workMode` first, then lower-case location text containing `remote`, `hybrid`, or `onsite/on-site`, otherwise `all`/unknown. Posted filtering uses `date-fns` or native date arithmetic and excludes invalid dates rather than throwing. Relevance preserves API order; match score sorts evaluated jobs descending and puts unevaluated jobs after them; newest sorts valid dates descending and leaves missing dates last. `isTypingTarget` returns true for `HTMLInputElement`, `HTMLTextAreaElement`, `HTMLSelectElement`, contenteditable elements, and descendants of one. Preserve the existing company filter as an optional client-side filter even though it is not prominent in the requested bar; it must be populated when loading a saved search.

`normalizeJobInsights` must read these optional `reportJson` keys, accepting arrays of strings or arrays of `{name:string}` objects: `matchedSkills`, `skills`, `skillGaps`, `missingSkills`, `evaluationResults`, `results`, and `breakdown`. Map common breakdown aliases (`skills`/`skillMatch`, `experience`/`experienceFit`, `keywords`/`keywordMatch`, `seniority`/`levelFit`) and convert current 0-5 values to percentages only when the key is clearly a 0-5 score. If no named breakdown is present, use current `scores.cvMatch` for skills and `scores.levelFit` for seniority only; leave experience/keywords absent. The helper must tolerate null, malformed JSON, and values outside the range.

### 2. Add focused workspace components (independent after step 1)

Create these files under `src/features/jobs/`:

#### `JobFilters.tsx`

Props:

```ts
interface JobFiltersProps {
  filters: JobSearchFilters;
  onChange: (next: JobSearchFilters) => void;
  onSearch: () => void;
  onClear: () => void;
  sources: readonly string[];
  resultCount: number;
  pending?: boolean;
  mobile?: boolean;
}
```

Render a labelled search `Input` with Enter calling `onSearch`, location `Input`, match score `Select` (`all`, `50`, `60`, `70`, `80`, `90`), work mode `Select` (`all`, `remote`, `hybrid`, `onsite`), source multi-select using shadcn `Checkbox` rows (not a native multi-select), posted-date `Select` (`all`, `day`, `week`, `month`), and sort `Select` (`relevance`, `matchScore`, `newest`). Use `Label` with unique `htmlFor` values. Include Search and Clear filters buttons, disabled/loading states, and a visible result count. Keep the current source names and capitalization. Search and location changes update state; only Search triggers the existing API mutation. Clear resets to query empty, all source/mode/date, no min score, relevance sort, and empty location.

#### `JobFiltersSheet.tsx`

Props:

```ts
interface JobFiltersSheetProps extends Omit<JobFiltersProps, 'mobile'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeFilterCount: number;
}
```

Render a mobile-only trigger button (`aria-label="Open job filters"`) with `SlidersHorizontal` and count badge. Use `Sheet open/onOpenChange`, `SheetContent side="left"`, `SheetHeader`, `SheetTitle`, and `SheetDescription`; render `JobFilters mobile` inside a scrollable container. Closing after Search is acceptable, but Clear must remain available. At `md` and above the trigger must be `hidden`; the inline filter bar must be `hidden md:block`.

#### `JobCard.tsx`

Replace the current props with:

```ts
interface JobCardProps {
  job: JobListingSummary;
  selected: boolean;
  evaluatedScore?: number;
  saved: boolean;
  onSelect: (job: JobListingSummary) => void;
  onSave: (job: JobListingSummary) => void;
  savePending?: boolean;
}
```

Make the card a semantic selectable `button`-like row without nesting interactive controls: the card container is a `div` with `role="option"`, `aria-selected`, `tabIndex={0}`, Enter/Space selecting, and a visible selected focus ring. The Save control is a separate icon `Button` with `aria-label` and `aria-pressed`, and calls `stopPropagation` for click and key events so saving never selects a different job. Show title, company, location, optional score (`Match score: NN%`), skills as max five `Badge`s plus `+N more`, posted label, source, and inactive warning. Do not render an unlabeled icon or truncate essential title text without a title/accessible name.

#### `JobListPanel.tsx`

Props:

```ts
interface JobListPanelProps {
  jobs: JobListingSummary[];
  selectedId?: string;
  evaluatedScores: Record<string, number>;
  savedIds: Set<string>;
  onSelect: (job: JobListingSummary) => void;
  onSave: (job: JobListingSummary) => void;
  loading?: boolean;
  error?: boolean;
}
```

Render a labelled `section` with `role="listbox"`, `aria-label="Job results"`, count heading, skeletons while loading, an error alert with retry supplied by the page, and a meaningful empty state. Use one-column vertical cards (`space-y-2`, `min-w-0`, `overflow-y-auto`, `overflow-x-hidden`), not the old responsive card grid. The list itself must be the scroll region on desktop.

#### `JobDetailPanel.tsx`

Props:

```ts
interface JobDetailPanelProps {
  jobId?: string;
  job?: JobListingSummary;
  onBack?: () => void;
  onSelectAdjacent?: (direction: 'next' | 'previous') => void;
}
```

Fetch the selected detail with `useQuery({ queryKey: ['jobs', 'detail', jobId], queryFn: () => jobsApi.get(jobId!), enabled: !!jobId })`; do not fetch when no job is selected. Render loading skeleton and a retryable error alert. Header shows title/company/location/source, Save, and a mobile Back button. Body sections (each `h2`) are Full description, Match score, Skill gaps, Evaluation results, and Actions.

Use a resume `Select` from `useResumes` only when Analyse is invoked or when an evaluation exists. Analyse calls `useEvaluateJob({ jobId, resumeId, jobDescription: detail.description })`, preserves the existing BYOK destructive error message, and stores the result in local state keyed by job id. Match score displays `overallScore` as a percentage only if an evaluation exists; otherwise show `Not analysed`. The breakdown uses four labelled `Progress` rows for skills, experience, keywords, seniority from `normalizeJobInsights`; omit unavailable rows and explicitly say `Breakdown is not available yet` if all are unavailable. Skill gaps and evaluation results render lists when present and an honest empty state otherwise. Keep `JobEvaluationReport` below/inside the Evaluation results section so its existing recommendation, scam warning, role summary, interview preparation, and red flags remain available; adapt it to accept the current contract rather than deleting information.

Actions must be exact:

- Save: create status `saved`; disable while pending; after success update the page's saved set through query invalidation and announce via existing toast.
- Analyse: select resume first; if none exist, show `Create a resume first` and navigate nowhere. Use `useEvaluateJob`.
- Tailor Resume: render existing `TailorPanel` when an evaluation and resume id exist; otherwise the button focuses/shows the resume selector and does not call tailor.
- Track Application: if saved application id exists, navigate `/app/applications`; otherwise create `status: 'saved'` then navigate only on success. Never create duplicate applications during a pending request.
- Open Original: `a href={applyUrl}` with `target="_blank"`, `rel="noreferrer"`, disabled/visually unavailable when no URL.

The detail panel must be a `section` with `aria-labelledby`, `min-w-0`, `overflow-y-auto`, and `overflow-x-hidden`. Long descriptions must not be sliced at 4000 characters (the current detail page truncates them). Render plain text with `whitespace-pre-wrap` and safe links only if the existing backend supplies them; do not use `dangerouslySetInnerHTML`.

#### `useJobSearchShortcuts.ts`

Create:

```ts
interface UseJobSearchShortcutsOptions {
  enabled: boolean;
  hasSelection: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onSave: () => void;
  onOpen: () => void;
  onAnalyse: () => void;
}
export function useJobSearchShortcuts(options: UseJobSearchShortcutsOptions): void;
```

Install one `window` keydown listener in `useEffect`, clean it up, and return early if `enabled` is false, `event.metaKey`, `event.ctrlKey`, `event.altKey`, or `isTypingTarget(event.target)` is true. `j` calls next, `k` previous, `s` save, `o` open original, and `a` analyse; prevent default only for handled shortcuts. Ignore repeats for action shortcuts. Do not use `keypress` or intercept shortcuts in inputs/selects/textareas/contenteditable elements.

### 3. Refactor `src/pages/Jobs.tsx` (sequential after steps 1-2)

Replace the current page body while preserving `AppLayout`, profile warning, board scan behavior, and navigation to Match/Profile. Import the new components, `useApplications`, `useQuery` if needed for detail state only in the panel, and the utilities.

State must be explicit:

```ts
const [filters, setFilters] = useState<JobSearchFilters>(DEFAULT_FILTERS);
const [results, setResults] = useState<JobListingSummary[]>([]);
const [selectedId, setSelectedId] = useState<string>();
const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
const [evaluationsByJob, setEvaluationsByJob] = useState<Record<string, JobEvaluation>>({});
```

Keep `useJobSearch`, `useScanBoards`, `useBoards`, `useCareerProfile`, `useApplications`, and existing manager callbacks. Fix the existing unused `URLSearchParams`: call `search.mutateAsync({ q: filters.query.trim(), sources: filters.sources.length ? filters.sources : undefined })`; apply location, mode, date, min score, and sort through `filterAndSortJobs` after the response. For board scan, use the same post-filter pipeline. A blank query remains allowed for board scan but Search stays disabled for blank query.

On result success, preserve the current selected id if still present; otherwise select the first result only when no selection exists. `useEffect` must synchronize `selectedId` to the `id` URL param only when the param is present; use `useParams` and `useNavigate`, not direct `window.history`. Selecting a card sets selected id and navigates to `/app/jobs/{id}`; on mobile set `mobileDetailOpen=true`. On desktop, render the detail beside the list. Use `md` as the breakpoint: below `md`, render only list when closed and only a full-screen detail view when open; above `md`, render both.

Use a top page header, then an inline filter bar, then a fixed-height workspace region such as `flex min-h-0 flex-1 gap-4 p-4 md:p-6`. Desktop list width must be `w-full md:w-[min(38%,28rem)] md:shrink-0`; detail is `min-w-0 flex-1`. Every ancestor in the workspace needs `min-h-0`; every text-heavy child needs `min-w-0`; set `overflow-x-hidden` on the page/workspace and use vertical overflow only. This is required because `AppLayout` prevents outer scrolling.

Keyboard navigation uses the currently filtered/sorted jobs, wraps at ends, and when moving selection navigates/opens mobile detail. `s`, `o`, and `a` delegate to the selected detail action through stable callbacks; if no selection, do nothing. Keep the shortcut hook enabled on both the list and mobile detail views so the requested shortcuts remain available; pass `enabled={true}` while the workspace is mounted (the hook still gates editable targets and modified keys). Ensure buttons have labels and are not triggered twice by card key handling.

Retain `BoardManager`, `SavedSearchManager`, and board scan in a secondary controls section. On mobile put these in a `Sheet` or collapsible section below the filter trigger; do not place them beside the job list in a third fixed column. Saved-search load must map all supported fields into `filters`; saved-search run must set the returned jobs and then apply selection. Do not call `onLoad({} as SavedSearch)` as the current manager does; if changing `SavedSearchManager`, change its `onRun` contract to return/pass actual `JobListingSummary[]` to the page.

### 4. Refactor `src/pages/JobDetail.tsx` (sequential)

Reduce this page to an `AppLayout` wrapper around `JobDetailPanel`, passing `jobId={id}` and `onBack={() => navigate('/app/jobs')}`. Remove duplicate `job`, `evaluation`, resume, save, and API state. The route must remain usable if opened directly, including loading/error/empty states. `JobDetailPanel` owns all action behavior. Do not change `src/App.tsx` routes.

### 5. Adapt existing job feature files (sequential)

- `src/features/jobs/JobEvaluationReport.tsx`: retain existing score labels and red flags, add accessible labels/`aria-valuetext` to progress bars, and avoid dynamic Tailwind class interpolation such as ` [&>div]:${scoreColor(v)}` if build-time class generation drops it; use a static class map. Accept only `JobEvaluation`.
- `src/features/jobs/TailorPanel.tsx`: keep all existing props and API calls. If adding a compact/action-row variant, add an optional `compact?: boolean` prop and preserve the current default rendering. Do not change template IDs or export behavior.
- `src/features/jobs/SavedSearchManager.tsx`: preserve create/delete/load behavior; optionally add `onRunResults?: (jobs: JobListingSummary[], search: SavedSearch) => void`, pass the actual `runSearch.mutateAsync` result, and remove the unsafe empty cast. Do not touch `BoardManager.tsx` unless required for layout wrapping.
- `src/features/jobs/JobCard.tsx`: implement step 2 replacement, not a second card component.

## CONSTRAINTS

- Do not change `src/components/layout/AppLayout.tsx`, `src/App.tsx`, global Tailwind theme tokens, backend files, database schemas, or existing API URL contracts.
- Do not remove or hide BoardManager, SavedSearchManager, Match jobs, profile-completion warning, scam/legitimacy information, interview prep, red flags, or tailoring/export functionality.
- Do not use `any` for new job/evaluation data; use `Record<string, unknown>` narrowing in the normalization helper.
- Do not use `dangerouslySetInnerHTML` for job descriptions.
- Do not nest Save/Action buttons inside an interactive card/button.
- All icon-only buttons require a visible tooltip or `aria-label`; use `aria-pressed` for Save and `aria-busy` for pending actions.
- Minimum touch target is 44px (`h-11 w-11` or equivalent) for mobile controls. Preserve visible `:focus-visible` rings.
- Use headings in order, labelled regions, `aria-live="polite"` for result count/loading/action status, and `role="alert"` for failures.
- Use `md` responsive classes, not JavaScript-only viewport branching. Do not introduce a new breakpoint or horizontal scroll.
- Avoid circular imports: feature components may import hooks/services/types; hooks may import services/types; services must not import feature components. Import types with `import type`.
- `JobDetailPanel` may be reused by both pages, but `JobsPage` remains the sole owner of list selection and URL navigation.

## TESTING STRATEGY

There is no frontend test runner in `package.json`. Add no new testing dependency in this UX slice unless the implementor is explicitly asked to do so. Verification is static/build plus manual browser acceptance.

1. Run `npm run lint`; it must pass with no new errors.
2. Run `npm run build`; it must pass TypeScript/Vite compilation.
3. Manually test at desktop width (>= 768px): search, each filter, clear, all three sorts, select with mouse/keyboard, save, analyse, tailor, track, open original, direct `/app/jobs/:id`, loading/error/empty states, board scan, saved search load/run.
4. Manually test below 768px and at 320px: list-only initial state, tap opens full-screen detail, Back returns to list, filter sheet opens/closes/focus restores, long title/description wraps, no horizontal scrollbar, actions remain reachable.
5. Keyboard test: focus page body and verify `j/k` wrap through filtered jobs, `s/o/a` invoke selected actions, and typing `jsk oa` into search/location/any textarea does not navigate or act. Verify Ctrl/Cmd/Alt modified keys do nothing.
6. Accessibility test with browser keyboard and an accessibility inspector: every region is labelled, selected option is announced, focus is visible, Sheet has title/description and trapped focus, progress rows have text values, and Save has a stateful accessible name.

## ACCEPTANCE CRITERIA

- [ ] `/app/jobs` shows a vertical left job list and selected-job detail panel at desktop widths without changing the visual theme.
- [ ] Cards show title, company, location, optional match score, key skills, posted date, source/closed state, and an accessible Save control.
- [ ] Detail shows the complete description, optional four-category breakdown, skill gaps, evaluation results, and all five requested actions.
- [ ] Search, match score, location, work mode, source, posted-date, and sort controls work against current API results; unavailable optional data is not fabricated.
- [ ] Match sorting never claims an unevaluated job has a score; unevaluated jobs sort after evaluated jobs.
- [ ] Mobile behavior is list -> full-screen detail -> Back, filters in a shadcn Sheet/Drawer, and no horizontal overflow at 320px.
- [ ] `j`, `k`, `s`, `o`, `a` work only outside typing targets and do not double-submit or steal browser shortcuts.
- [ ] Existing evaluation, scam warning, tailoring, resume selection, application pipeline, board scan, and saved-search flows remain functional.
- [ ] `npm run lint` and `npm run build` pass.

## RISKS AND FAILURE MODES

- **Backend payload variability:** current types do not guarantee skills, match breakdown, or skill gaps. The normalizer must show explicit unavailable states, never `0%` or invented skills. If backend later standardizes fields, update only the normalizer/type contract.
- **Saved application duplication:** `useApplications` can be stale while a save is pending. Disable all save/track controls during mutation and invalidate `applicationsQueryKey` on success. Compute saved IDs from the latest query plus an optimistic local pending set if needed.
- **Direct detail route:** `/app/jobs/:id` has no list result context. The shared panel must fetch the detail independently and still render; no assumption that `job` exists in `results`.
- **URL/result race:** an id from the URL may not be in current results. Keep it selected and show detail; do not clear it merely because a search response lacks that id. Clear only on explicit Clear/search result selection policy.
- **Invalid dates and work mode:** missing or malformed dates must be displayed as `Date unavailable` and excluded from date-specific filters. Unknown work mode must remain visible under All, not be silently classified as onsite.
- **Focus on mobile navigation:** when opening detail, focus the detail heading/back control after render; when returning, restore focus to the selected card. Radix Sheet handles filter focus restoration, but card/detail focus must be implemented with refs.
- **Long content:** constrain only the detail scroll region, not the description. Use `break-words`, `min-w-0`, and `overflow-x-hidden`; never use fixed-width prose that can overflow.
- **Shortcut actions requiring resume:** `a` should open/focus the resume selector or announce that a resume is required, not fire an API request with an empty id.

## IMPLEMENTOR MUST VERIFY

1. `src/services/api/jobs.ts` and `src/services/api/index.ts` contain the exact optional contracts and exported types from Step 1.
2. `src/features/jobs/jobSearchUtils.ts` exists, has all seven exact exports, has no unsafe casts, and handles malformed optional payloads.
3. `JobFilters.tsx`, `JobFiltersSheet.tsx`, `JobListPanel.tsx`, `JobDetailPanel.tsx`, and `useJobSearchShortcuts.ts` exist with the exact prop/signature contracts.
4. `JobCard.tsx` has `role="option"`, `aria-selected`, keyboard selection, and a non-nested accessible Save button.
5. `Jobs.tsx` owns filters/results/selection, applies client-side filtering/sorting, preserves board/saved-search/profile flows, and uses `/app/jobs/:id` for selection.
6. `JobDetail.tsx` is only the routed `AppLayout` wrapper and shared panel; duplicate detail/evaluation state is removed.
7. `JobEvaluationReport.tsx` and `TailorPanel.tsx` retain all existing information and API behavior.
8. Desktop uses two panes and mobile uses one full-screen view at a time; every workspace axis is overflow-safe.
9. Save and Track Application use existing application hooks and never create duplicates while pending.
10. Shortcut listener ignores all typing/editable targets and modified/repeated keys and cleans up on unmount.
11. Run `npm run lint` and `npm run build`, then complete the manual desktop, mobile, keyboard, and accessibility checks listed above.
