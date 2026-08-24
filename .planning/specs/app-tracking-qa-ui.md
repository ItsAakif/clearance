# Frontend implementation spec: application tracking and Q&A bank

## OBJECTIVE

Replace the current six-column, status-only `Applications` view with a responsive application workspace: a status pipeline, actionable analytics, reminders, per-application event timeline, terminal `withdrawn`/`ghosted` states, and comparison of two or three tracked jobs. Add an authenticated `/app/qa` page for question/answer CRUD, category and tag organization, job-aware AI answer generation, and clipboard copying.

The frontend must use the existing React Query, `apiClient`, `AppLayout`, Tailwind, and shadcn primitives. Do not add a state-management library or a chart library; Recharts and `components/ui/chart.tsx` are already installed but the analytics can be rendered with CSS bars and metric cards.

## ARCHITECTURE DECISIONS

1. Keep `/app/applications` as the tracking route and add `/app/qa` as a separate page. A separate route keeps the application page focused and makes Q&A directly bookmarkable.
2. Keep server state in React Query. Selection, open dialogs, filters, and form drafts remain local `useState`; do not put IDs on `window` (unlike the existing `useCompareJobs` helper).
3. Treat the server's `ApplicationEvent` list as the timeline source of truth. Status changes are created by the existing application PATCH endpoint; note, follow-up, and interview events are created explicitly by the event endpoint.
4. Reminders use the existing `Application.followUpAt` field for the list/dashboard query and also create a `follow_up` event so the reminder is visible in the timeline. Date-only input must be converted to an ISO timestamp at local start-of-day before sending.
5. The pipeline includes `saved`, `tailored`, `applied`, `interview`, `offer`, `rejected`, `withdrawn`, and `ghosted`. The visual funnel order is `saved -> tailored -> applied -> interview -> offer`; rejected, withdrawn, and ghosted are terminal side columns/filter states, not funnel stages.
6. Analytics are computed in the client from the authenticated application list. This avoids a new analytics endpoint and keeps the definitions transparent. Average match score requires the list response to expose the user's latest evaluation score for each listing (contract below).
7. AI Q&A generation is a dedicated API operation returning answer text; do not call an LLM directly from the browser and never send provider keys from the browser. The operation reuses backend provider selection/BYOK infrastructure.
8. Job comparison is limited to jobs already in the user's application list. Use `jobsApi.compare` for full listing details, while status and match score come from the selected `Application` objects. Require 2 or 3 selections and disable compare otherwise.

Rejected alternatives: a new tracking database table is unnecessary because `Application`, `ApplicationEvent`, `followUpAt`, `ghostedAt`, and `withdrawnAt` already exist. A separate analytics API is unnecessary for the requested simple metrics. Embedding Q&A in Applications would make both workflows harder to navigate and test.

## CURRENT STATE VERIFIED

- `src/pages/Applications.tsx:10-17` currently supports only `saved`, `tailored`, `applied`, `interview`, `offer`, and `rejected`; it renders columns and changes status.
- `src/hooks/useJobs.ts:86-143` already has application, event, and Q&A query/mutation hooks, but no event-update hook, no AI-Q&A hook, and no optimistic or selected-detail state.
- `src/services/api/jobs.ts:43-70,161-190` already defines application/event/Q&A types and CRUD endpoints. `Application.status` excludes the two required terminal states. `Application.jobListing` has no match score or evaluation summary.
- `backend/src/routes/applications.ts:54-65` includes events in list results; `:89-135` updates dates and automatically creates status-change events; `:151-219` provides authenticated event list/create/update endpoints.
- `backend/src/routes/question-answers.ts:12-92` already provides authenticated list, create, patch, and delete endpoints with category and text filtering.
- `backend/prisma/schema.prisma:385-439` already contains the required application date fields, `ApplicationEvent`, and `QuestionAnswer` (`tags` is JSON). No Prisma migration is needed for this UI.
- `backend/src/shared/validation.ts:138-152` currently rejects `withdrawn` and `ghosted`; this is a backend compatibility prerequisite, not a frontend workaround.
- `src/App.tsx:11-125` uses lazy protected routes; `src/components/layout/AppLayout.tsx:12-52` owns the sidebar nav.
- `recharts` is installed, but this spec deliberately uses metric cards/CSS to avoid unnecessary chart complexity.

## STEPS

### 1. Establish shared client contracts (sequential; prerequisite for all UI)

Modify `src/services/api/jobs.ts` in the type and API sections around lines 43-190:

- Change `Application.status` to:

```ts
export type ApplicationStatus =
  | "saved" | "tailored" | "applied" | "interview" | "offer"
  | "rejected" | "withdrawn" | "ghosted";
```

- Add this shape and expose it on `Application`:

```ts
export interface ApplicationMatchSummary {
  overallScore: number;
  evaluatedAt: string;
}

export interface ApplicationJobListing {
  title: string;
  company: string;
  applyUrl?: string;
  location?: string;
  match?: ApplicationMatchSummary | null;
}
```

Use `jobListing?: ApplicationJobListing` in `Application` (preserve tailored resume and events). Use `ApplicationStatus` for status fields and all update/create payloads.

- Extend `applicationsApi.update` status to `ApplicationStatus` and add `remove` return type `void` only if it is currently inferred loosely; preserve endpoint paths.
- Add `generateInterviewAnswer` to a new `aiApi` export in `src/services/api/ai.ts` (preferred to putting AI in `jobs.ts`):

```ts
export type InterviewAnswerCategory = "behavioral" | "technical" | "situational" | "general";
export interface GenerateInterviewAnswerInput {
  question: string;
  category?: InterviewAnswerCategory;
  jobListingId?: string;
}
export interface GenerateInterviewAnswerResponse { answer: string; }
export const aiApi = {
  generateInterviewAnswer: (payload: GenerateInterviewAnswerInput) =>
    apiClient.post<GenerateInterviewAnswerResponse>("/ai/generate-interview-answer", payload),
};
```

Export `aiApi` and its types from `src/services/api/index.ts`. Do not duplicate `apiClient` logic in pages.

### 2. Add/adjust React Query hooks (sequential after step 1)

Modify `src/hooks/useJobs.ts`:

- Import `aiApi`, `ApplicationStatus`, and `InterviewAnswerCategory` from `@/services/api`.
- Keep `applicationsQueryKey` and `questionAnswersQueryKey` unchanged for cache compatibility.
- Change `useCreateApplication` and `useUpdateApplication` payload statuses to `ApplicationStatus`.
- Add `useUpdateApplicationEvent()` after `useCreateApplicationEvent()`:

```ts
mutationFn: (vars: {
  applicationId: string; eventId: string;
  title?: string; description?: string;
  scheduledAt?: string | null; completedAt?: string | null;
}) => applicationsApi.updateEvent(vars.applicationId, vars.eventId, vars),
onSuccess: (_, vars) => qc.invalidateQueries({
  queryKey: ["applications", vars.applicationId, "events"],
}),
```

Use the same existing toast error pattern (`title: 'Failed to update event'`, destructive).

- Add `useGenerateInterviewAnswer()` with `mutationFn: (data: GenerateInterviewAnswerInput) => aiApi.generateInterviewAnswer(data)`. On errors use title `AI answer generation failed`, destructive; do not persist automatically.
- Existing Q&A CRUD hooks are correct and must remain backward compatible. Their category types may be tightened to `QuestionAnswer['category']` but do not make nullable server values crash the UI.

### 3. Add application feature components (independent files; can be implemented in parallel)

Create `src/features/applications/applicationConstants.ts`:

- Export `FUNNEL_STAGES`, `TERMINAL_STAGES`, `ALL_APPLICATION_STATUSES`, `APPLICATION_EVENT_TYPES`.
- Export typed label/color/icon maps. Labels: `Saved`, `Tailored`, `Applied`, `Interview`, `Offer`, `Rejected`, `Withdrawn`, `Ghosted`.
- Status transition select must include all eight statuses. The delete/trash icon must not be used as a substitute for rejected/withdrawn/ghosted.

Create `src/features/applications/applicationAnalytics.ts`:

- Export `computeApplicationAnalytics(apps: Application[])` and return:

```ts
{ applications: number; interviews: number; offers: number;
  responseRate: number | null; averageMatchScore: number | null; }
```

- Definitions: `applications` is all rows; `interviews` is rows with status `interview` or `offer`; `offers` is rows with status `offer`; denominator is rows with `appliedAt` or status in `interview|offer|rejected|withdrawn|ghosted`; responded numerator is `interview|offer|rejected`; response rate is `null` when denominator is zero, otherwise rounded to one decimal percentage; average match score is the arithmetic mean of non-null `jobListing.match.overallScore`, rounded to one decimal, or `null` when none exists. Never treat ghosted as a response.

Create `src/features/applications/ApplicationAnalytics.tsx`:

- Props: `{ apps: Application[] }`.
- Render five shadcn `Card`s with accessible labels and values: Applications, Interviews, Offers, Response rate, Avg. match score. Show `-` for null values and `No applications yet` empty copy only below the cards when `apps.length === 0`.
- Use lucide icons, `text-muted-foreground`, and responsive `grid-cols-2 lg:grid-cols-5`.

Create `src/features/applications/ApplicationPipeline.tsx`:

- Props: `{ apps: Application[]; selectedIds: string[]; onToggleCompare(id: string): void; onOpen(app: Application): void; onStatusChange(app: Application, status: ApplicationStatus): void }`.
- Render funnel columns in `FUNNEL_STAGES`, terminal columns below or after them. Each card shows job title/company, status badge, latest match score if available, follow-up badge if `followUpAt`, an accessible compare checkbox, and a `Details` button. Keep the current posting external link.
- Use horizontal scrolling on narrow screens (`overflow-x-auto`, min-width columns), not a six-column layout that clips content. Disable compare checkboxes when three IDs are selected unless the current item is already selected.
- Use `useUpdateApplication` only through the parent callback or accept mutation via parent; do not create one mutation per card.

Create `src/features/applications/ApplicationTimeline.tsx`:

- Props: `{ app: Application; events: ApplicationEvent[]; onAddEvent(data: CreateApplicationEventInput): void; onUpdateEvent(eventId: string, data: UpdateApplicationEventInput): void; isSaving: boolean }`.
- Render events sorted ascending by `createdAt` with a vertical connector, event-type icon, title fallback from type, description, created date, scheduled date, and completed state. Status event fallback title is `Status changed to {toStatus}`.
- Include an `Add event` dialog using `Dialog`, `Select`, `Input`, `Textarea`, `Calendar`/date input. Event type choices: Note (`note_added`), Follow-up (`follow_up`), Interview (`interview_scheduled`), Offer (`offer_received`), Rejected (`rejected`), Withdrawn (`withdrawn`). Do not expose `status_change` as a manual choice.
- For scheduled types require a date before submit; send ISO strings. Edit title/description/scheduledAt/completedAt using the existing patch endpoint. Show mutation errors via hook toast and keep dialog open on error.

Create `src/features/applications/FollowUpReminders.tsx`:

- Props: `{ apps: Application[]; onSetReminder(app: Application, date: string | null): void }`.
- Show upcoming reminders where `followUpAt` is non-null, sorted ascending, with title/company, date, status, and `Set/Change` and `Clear` controls. Include overdue styling for dates before now. Empty state says `No follow-ups scheduled`.
- Date input must use `type="date"`; parent converts the date to ISO. Clear sends `null` and must remove the reminder row after invalidation.

Create `src/features/applications/ApplicationDetailDialog.tsx`:

- Props: `{ app: Application | null; onClose(): void; onStatusChange(...); onSetReminder(...); }`.
- Use a shadcn `Dialog` with job metadata, external posting link, status `Select`, notes editor (save via `useUpdateApplication`), reminder control, and `ApplicationTimeline`.
- Use `useApplicationEvents(app?.id ?? "")` only when open. Show `Skeleton` while loading and an error message with retry via query refetch. Do not render an empty timeline as a failure.

Create `src/features/applications/JobComparisonDialog.tsx`:

- Props: `{ apps: Application[]; selectedIds: string[]; open: boolean; onOpenChange(open: boolean): void }`.
- On open, call `jobsApi.compare(selectedIds)` through a dedicated `useQuery` or the existing `useCompareJobs` refactored to accept IDs as a query key. Do not use `window.__compareJobIds`.
- Render 2-3 equal-width columns with title/company/location, status, latest match score, posted date, truncated description, and `View posting`. Loading/error/empty states must be explicit. On mobile, allow horizontal scrolling.
- Never send IDs not selected in the current page and do not allow a fourth item.

### 4. Replace Applications page (sequential after feature components)

Modify `src/pages/Applications.tsx` substantially (replace the current `AppColumn` implementation):

- Use `useApplications`, `useUpdateApplication`, `useCreateApplicationEvent`, and the new components. Keep `AppLayout` and the existing full-height/overflow structure.
- Header actions: page title/subtitle, `Compare selected (n/3)` button disabled below two selections, and a compact status filter (`all`, funnel stages, terminal stages). Filter is local and must not change the query.
- Body order: `ApplicationAnalytics`, `FollowUpReminders`, a `Tabs` with `Pipeline` and `Timeline`/detail-on-select is acceptable, but the default must visibly include the pipeline. Prefer a details dialog so all applications remain visible.
- Empty state must include a `Briefcase` icon, existing guidance, and a link/button to `/app/jobs`.
- On status change, call `update.mutate({ id, status })`; on reminder, call update with `followUpAt`, then create a follow-up event only when setting a non-null new date. Avoid duplicate event when only changing an existing reminder unless the date changed.
- Convert date-only string with `new Date(`${date}T00:00:00`).toISOString()`; clear uses `null`.
- For notes, send `notes` through application PATCH. For event creation pass `applicationId` only to the URL helper; the payload must not redundantly include it because `applicationsApi.createEvent` currently accepts it as its first argument.
- On every mutation invalidate the relevant application list/events keys through hooks; show disabled controls while pending.

### 5. Add Q&A page and feature components (independent of application UI after step 2)

Create `src/features/question-answers/QuestionAnswerForm.tsx`:

- Props: `{ initial?: QuestionAnswer; onSubmit(data: QuestionAnswerWriteInput): Promise<void>; onCancel?(): void; isSaving: boolean }`.
- Define `QuestionAnswerWriteInput = { question: string; answer: string; category?: InterviewAnswerCategory; notes?: string; tags?: string[] }`.
- Controlled fields: question (required), answer (required), category select with four categories, notes textarea, tags input. Tags are comma-separated in the UI, trimmed, lowercased, deduplicated, and limited client-side to 20; server remains authoritative.
- Use `Label`, `Input`, `Textarea`, `Select`, `Button`; disable submit for blank required fields and while saving. Use `aria-label` for tag input.

Create `src/features/question-answers/QuestionAnswerCard.tsx`:

- Props: `{ item: QuestionAnswer; onEdit(item): void; onDelete(id): void; onCopy(item): void }`.
- Show question, answer with preserved whitespace, category badge (or `Uncategorized`), tag badges, notes in muted text, and updated date. Actions are edit, copy, delete.
- Copy uses `navigator.clipboard.writeText` with `Question: ...\n\nAnswer: ...`; fallback error toast says `Clipboard access is unavailable`.

Create `src/features/question-answers/GenerateAnswerDialog.tsx`:

- Props: `{ open: boolean; onOpenChange(open): void; jobs: Application[]; onUseAnswer(answer: string): void }`.
- Fields: question, category, selected job (`No specific job` plus application jobs). Submit `useGenerateInterviewAnswer` with `{ question, category, jobListingId }` (omit undefined values). Render generated answer in a read-only textarea/card with `Copy` and `Use this answer`; `Use` places it into the form and closes the dialog, never saves automatically.
- Handle missing API key/backend failure with the existing error message plus a link/button to `/app/settings`; do not expose raw provider errors or keys.

Create `src/pages/QuestionAnswers.tsx`:

- Use `useQuestionAnswers({ category: category === "all" ? undefined : category, q: debouncedSearch })`, the three Q&A mutations, and `useApplications` for AI job choices. Add a 250ms debounce with `useEffect` or use immediate search if simpler; query key must remain filter-aware.
- Header: `Q&A Bank`, explanation, `Add question` and `Generate with AI` buttons.
- Toolbar: search input, category select, and tag display/filter. Because backend only supports category/q, tag filtering must be client-side only when tag filter is active: fetch the category/search result and filter `item.tags` locally. Do not invent a `tags` query parameter.
- Render responsive cards/list, loading `Skeleton`s, error state with retry, and empty state that distinguishes no entries from no search matches.
- Add/edit uses a `Dialog` containing `QuestionAnswerForm`. Delete uses `AlertDialog` confirmation with question text; after success close edit state and rely on query invalidation. Escape/cancel must not submit.
- Toast copy follows existing patterns: `Q&A added`, `Q&A updated`, `Q&A removed`, and destructive errors from hooks.

### 6. Route and navigation wiring (sequential after page exists)

Modify `src/App.tsx`:

- Add `const QuestionAnswers = lazy(() => import("./pages/QuestionAnswers"));` beside the other lazy page imports.
- Add a protected route immediately after applications:

```tsx
<Route path="/app/qa" element={<ProtectedRoute><QuestionAnswers /></ProtectedRoute>} />
```

Modify `src/components/layout/AppLayout.tsx`:

- Import `MessageCircleQuestion` (or another available lucide icon) and add `{ label: "Q&A Bank", href: "/app/qa", icon: MessageCircleQuestion }` immediately after Applications in `baseNavItems`.
- Preserve active matching behavior (`pathname === href || startsWith(href + "/")`), collapsed/mobile behavior, and admin nav.

### 7. Backend compatibility contracts required for the frontend to work (sequential prerequisite; exact paths)

Although this packet is frontend-focused, the existing backend rejects two required statuses and lacks the AI operation/match projection. Implement these narrowly; do not change Prisma models or unrelated routes.

Modify `backend/src/shared/validation.ts:138-152`:

```ts
const applicationStatusEnum = z.enum([
  'saved', 'tailored', 'applied', 'interview', 'offer',
  'rejected', 'withdrawn', 'ghosted',
]);
// Use applicationStatusEnum in both createApplicationSchema.status and updateApplicationSchema.status.
```

Modify `backend/src/routes/applications.ts:56-65` so each application includes only the latest evaluation belonging to the authenticated user. Use Prisma's nested relation filter directly in the existing `findMany` (no extra endpoint):

```ts
jobListing: {
  select: {
    title: true, company: true, applyUrl: true, location: true,
    evaluations: {
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { overallScore: true, createdAt: true },
    },
  },
},
```

After the query, map each response row so `jobListing.evaluations[0]` becomes `jobListing.match = { overallScore: Number(...), evaluatedAt: createdAt.toISOString() }`, or `null` when there is no evaluation, and remove the internal `evaluations` array before `res.json`. Apply the same projection/mapping to `GET /applications/:id` so detail and list shapes agree. This is safe because the nested `where` is explicitly `req.user!.id`; never expose another user's evaluation. The response contract must be:

```json
{
  "jobListing": {
    "title": "...", "company": "...", "applyUrl": "...", "location": "...",
    "match": { "overallScore": 87, "evaluatedAt": "2026-08-24T...Z" }
  }
}
```

Never expose another user's evaluation. If no evaluation exists, return `match: null`.

Create `backend/src/ai/interviewGenerator.ts` using the same provider/key selection and model-call helper used by `backend/src/ai/resumeGenerator.ts`; export `generateInterviewAnswer({ question, category, job })`. The prompt must instruct the model to produce truthful, concise interview preparation text, never invent candidate experience, and return answer text only. Cap input lengths in the route.

Modify `backend/src/routes/ai.ts` with `POST /generate-interview-answer`, `requireAuth`, exact input validation (`question` 1-500, category enum, optional UUID `jobListingId`), ownership-scoped job lookup, and response `{ answer }`. For missing/invalid job IDs return the existing `BadRequestError`/not-found behavior, and route all errors through `handleApiError`.

Update the backend route test surface (prefer `backend/src/routes/api.smoke.test.ts` or add `backend/src/routes/question-answers.test.ts`) to assert status validation and the new authenticated endpoint contract. Do not add a database migration: schema fields already exist.

## CONSTRAINTS

- Preserve `apiClient` authentication/error handling, React Query cache keys, `ProtectedRoute`, `AppLayout`, shadcn component conventions, and existing API paths.
- All user-owned data must remain server-scoped; frontend must not cache or display another user's job evaluation.
- Do not auto-submit applications; external posting links remain `target="_blank" rel="noreferrer"`.
- Do not use `dangerouslySetInnerHTML` for answers, notes, descriptions, or event text.
- Do not add Prisma columns/migrations for this request. Do not modify `QuestionAnswer` CRUD route semantics.
- Do not replace the entire layout, theme, or sidebar. Do not remove existing Q&A hooks or application event APIs.
- Dates must be ISO strings for API calls and formatted with `date-fns` for display. Guard malformed/null dates and render `Unknown date` rather than throwing.
- All mutation buttons need pending disabled states; dialogs must be keyboard accessible; icon-only buttons need `aria-label` and a `Tooltip` where the meaning is not obvious.
- Import order: external React/router/query imports first, `@/` imports next, type-only imports grouped with their source. Avoid importing page components into feature components to prevent cycles; API types come from `@/services/api`.
- `ApplicationEvent` has no delete endpoint. Do not render a delete event action; edit is limited to the existing PATCH fields.

## TESTING STRATEGY

Create `src/features/applications/applicationAnalytics.test.ts` if the frontend test runner is introduced; otherwise put pure-function assertions in the project's configured test location without adding an incompatible runner. Assertions must cover: zero apps, null response rate, status interview/offer counts, rejected as response, ghosted as non-response, and average score ignoring nulls.

Add component tests (if the repository adopts a browser test runner) at:

- `src/features/applications/ApplicationPipeline.test.tsx`: all eight statuses render; selecting a fourth compare item is disabled; opening details calls the callback.
- `src/features/applications/ApplicationTimeline.test.tsx`: events render chronological order; scheduled event requires a date; status change is not a manual event option.
- `src/features/question-answers/QuestionAnswerForm.test.tsx`: required validation, category selection, tag trim/dedupe, submit payload.
- `src/pages/QuestionAnswers.test.tsx`: category/search query filters, edit/delete mutation calls, copy payload, AI use-answer populates form.

At minimum, verification commands are:

```text
npm run lint
npm run build
cd backend; npm test
cd backend; npm run build
```

Run the backend commands from `backend` using the repository's PowerShell working-directory facility rather than relying on a shell `cd`. Manually verify as an authenticated user: route protection, pipeline status changes, reminder set/clear and overdue display, timeline event create/edit, compare exactly 2 and 3 jobs, Q&A CRUD/category/tag/search, clipboard success/failure, AI missing-key error, and mobile horizontal scrolling.

## ACCEPTANCE CRITERIA

1. `/app/applications` loads without a runtime/type error and displays five metrics plus a responsive pipeline.
2. All eight statuses can be viewed and selected; moving status creates the server's status-change event, and withdrawn/ghosted persist after reload.
3. Each application can open a detail dialog with job metadata, notes, reminder, and chronological events; notes/follow-ups/interviews can be added and scheduled dates are visible.
4. Upcoming reminders are sorted, overdue reminders are visually distinct, and set/clear survives a full reload.
5. Analytics exactly follow the definitions in `applicationAnalytics.ts`, including null-safe response rate and average match score.
6. Two or three selected tracked jobs compare side by side; one or four cannot start comparison; no fourth checkbox can be selected.
7. `/app/qa` is protected, linked from the sidebar, and supports create/read/update/delete with all four categories, normalized tags, search, and category filtering.
8. AI generation sends only the documented payload, can target a selected job, shows loading/error states, allows copy/use, and never auto-saves or exposes keys.
9. Copy writes the exact question/answer format to the clipboard and reports unavailable clipboard access without crashing.
10. Lint, frontend build, backend tests, and backend build pass; existing pages/routes remain functional.

## RISKS AND COMPATIBILITY

- The current backend status schemas do not accept `withdrawn` or `ghosted`; step 7 is mandatory before those UI controls can work. Do not silently fall back to `rejected` because that loses user intent.
- The current application list does not expose match scores. If backend projection is not implemented, average match score must display `-` rather than guessing from unrelated job-match rows; do not make an unauthenticated or cross-user query.
- There is no existing interview-answer generator. The backend must reuse its existing provider/key helper and rate limiting conventions; if that helper cannot accept a job context, pass only a sanitized job title/company/description excerpt and keep the UI contract unchanged.
- `tags` is JSON and the list API has no tag filter. Client-side filtering is correct for this scope but may be expensive for a very large bank; a server-side filter can be added later without changing the page contract.
- Existing applications may have arbitrary legacy status strings despite the schema intent. Render an `Unknown` badge and include them in an `Other` fallback section rather than crashing or dropping the row.
- Browser clipboard access requires a secure context and permission; the explicit failure toast is required.
- No schema migration is planned. If an environment's deployed Prisma schema does not match the checked-in schema, deployment must run the normal existing Prisma migration/push process separately; do not add speculative migration SQL to this frontend change.

## IMPLEMENTOR MUST VERIFY

- [ ] `src/services/api/jobs.ts` exports `ApplicationStatus`, match summary, and eight statuses.
- [ ] `src/services/api/ai.ts` and `src/services/api/index.ts` export the exact AI contract.
- [ ] `src/hooks/useJobs.ts` contains event-update and AI-generation hooks with invalidation/error behavior.
- [ ] All five application feature files exist with the stated props and null/error/loading behavior.
- [ ] `src/pages/Applications.tsx` uses analytics, reminders, pipeline, detail, and comparison components; no six-column-only implementation remains.
- [ ] Q&A feature files and `src/pages/QuestionAnswers.tsx` implement CRUD, filters, tags, AI use, and clipboard behavior.
- [ ] `src/App.tsx` has protected `/app/qa`; `AppLayout.tsx` has the Q&A Bank nav item.
- [ ] Backend validation accepts eight statuses, application responses safely expose latest own match, and `/ai/generate-interview-answer` exists with auth/validation.
- [ ] No Prisma schema/migration or unrelated route changes were made.
- [ ] Lint, frontend build, backend tests, and backend build pass, plus the manual flows in the testing section.
