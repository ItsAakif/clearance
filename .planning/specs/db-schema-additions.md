# Database schema additions implementation specification

## OBJECTIVE

Add the persistent data needed for a user's interview Q&A bank, application timeline, and saved-search alerts, while adding follow-up lifecycle timestamps and saved-search matching metadata. Add the API and client contracts needed to consume those records, including a read-only job comparison endpoint. All changes are additive: existing tables, columns, routes, status values, and data must remain usable.

## Current repository facts

The checked-out `HEAD` schema ends at `Application` and has none of the requested additions. The working tree's `backend/prisma/schema.prisma` already contains an uncommitted draft of the requested fields and three models (lines 65-68, 256-275, 367-446). Treat that draft as reconnaissance, not as an applied migration: it has no migration directory, no routes, no client types, and no generated API contract for these features. Preserve unrelated working-tree changes; do not revert or reformat the whole schema.

The existing backend uses Express 4, Prisma 5.22, Zod, and `handleApiError`/`requireAuth`. Existing route mounting is in `backend/src/routes/index.ts`. The requested `backend/src/services/api/jobs.ts` path does not exist; the actual browser API service is `src/services/api/jobs.ts` and must be used.

## Architecture decisions

1. **Use the three requested Prisma models exactly as the durable records.** `QuestionAnswer` belongs to `User`; `ApplicationEvent` belongs to `Application`; `JobAlert` belongs to `User` and may reference `SavedSearch`.
2. **Do not add a `JobComparison` table.** Comparison is a transient view of existing `JobListing` rows, and no user-owned state or comparison history was requested. Persisting snapshots would duplicate listing data and create stale records. Implement `GET /api/jobs/compare?ids=...` as a bounded, user-authenticated read projection. If product later requires named/saved comparisons, that is a separate schema change.
3. **Use scalar strings rather than Prisma enums**, matching existing `status`, source, and category conventions. Zod validates the documented finite values at the API boundary.
4. **Ownership is mandatory where the schema supports it.** Q&A and alerts filter by `userId`; events authorize through the owning Application. `JobListing` is globally shared and currently has no owner, so comparison is an authenticated read of any existing listing ID, capped at four IDs; do not invent a `JobListing.userId` column.
5. **Use explicit relation field names and delete behavior.** The draft's capitalized `User` relation fields are legal-looking but inconsistent and make generated client usage awkward. Use `user` on `QuestionAnswer` and `JobAlert`, with `onDelete: Cascade`. Use `application` on `ApplicationEvent`, with `onDelete: Cascade`. Keep `JobAlert.savedSearch` optional with `onDelete: SetNull` so deleting a saved search does not delete an alert.

## STEPS

### Step 1 - Reconcile the Prisma schema (sequential; prerequisite for all DB/API work)

Modify only `backend/prisma/schema.prisma` in the existing `User`, `SavedSearch`, and `Application` blocks and append the three models. Do not remove any existing model or field.

Add these `User` relation fields:

```prisma
questionAnswers QuestionAnswer[]
jobAlerts       JobAlert[]
```

Add these fields to `SavedSearch` (retain all existing fields):

```prisma
minMatchScore Int?
remoteOnly    Boolean   @default(false)
sortBy        String    @default("relevance")
lastRunAt     DateTime?
matchCount    Int       @default(0)
alerts        JobAlert[]
```

Add these fields to `Application` (retain all existing fields and `events` relation):

```prisma
followUpAt DateTime?
ghostedAt  DateTime?
withdrawnAt DateTime?
```

The final models must be exactly:

```prisma
model QuestionAnswer {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  question  String
  answer    String   @db.Text
  category  String?
  notes     String?
  tags      Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([category])
}

model ApplicationEvent {
  id            String      @id @default(uuid())
  applicationId String
  application   Application @relation(fields: [applicationId], references: [id], onDelete: Cascade)
  type          String
  fromStatus    String?
  toStatus      String?
  title         String?
  description   String?     @db.Text
  scheduledAt   DateTime?
  completedAt   DateTime?
  createdAt     DateTime    @default(now())

  @@index([applicationId])
  @@index([scheduledAt])
}

model JobAlert {
  id             String       @id @default(uuid())
  userId         String
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  savedSearchId  String?
  savedSearch    SavedSearch? @relation(fields: [savedSearchId], references: [id], onDelete: SetNull)
  name           String
  query          String
  location       String?
  sources        Json?
  minMatchScore  Int?
  remoteOnly     Boolean      @default(false)
  isActive       Boolean      @default(true)
  lastRunAt      DateTime?
  lastMatchCount Int          @default(0)
  notifyInApp     Boolean      @default(true)
  notifyEmail     Boolean      @default(false)
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt

  @@index([userId])
  @@index([isActive, lastRunAt])
}
```

`tags` and `sources` are JSON arrays of strings. Do not add JSON database checks; existing project conventions validate JSON shape in Zod.

### Step 2 - Add the non-destructive migration (sequential)

Create `backend/prisma/migrations/<timestamp>_job_alerts_qa_application_events/migration.sql` using the repository's normal Prisma migration naming. The generated migration must be equivalent to the following PostgreSQL operations (use the actual Prisma-generated SQL for UUID/default quoting if `prisma migrate dev` produces a byte-for-byte variant):

```sql
ALTER TABLE "Application" ADD COLUMN "followUpAt" TIMESTAMP(3);
ALTER TABLE "Application" ADD COLUMN "ghostedAt" TIMESTAMP(3);
ALTER TABLE "Application" ADD COLUMN "withdrawnAt" TIMESTAMP(3);

ALTER TABLE "SavedSearch" ADD COLUMN "minMatchScore" INTEGER;
ALTER TABLE "SavedSearch" ADD COLUMN "remoteOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SavedSearch" ADD COLUMN "sortBy" TEXT NOT NULL DEFAULT 'relevance';
ALTER TABLE "SavedSearch" ADD COLUMN "lastRunAt" TIMESTAMP(3);
ALTER TABLE "SavedSearch" ADD COLUMN "matchCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "QuestionAnswer" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "category" TEXT,
  "notes" TEXT,
  "tags" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuestionAnswer_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ApplicationEvent" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "applicationId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "title" TEXT,
  "description" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApplicationEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "JobAlert" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "savedSearchId" TEXT,
  "name" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "location" TEXT,
  "sources" JSONB,
  "minMatchScore" INTEGER,
  "remoteOnly" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt" TIMESTAMP(3),
  "lastMatchCount" INTEGER NOT NULL DEFAULT 0,
  "notifyInApp" BOOLEAN NOT NULL DEFAULT true,
  "notifyEmail" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobAlert_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "QuestionAnswer_userId_idx" ON "QuestionAnswer"("userId");
CREATE INDEX "QuestionAnswer_category_idx" ON "QuestionAnswer"("category");
CREATE INDEX "ApplicationEvent_applicationId_idx" ON "ApplicationEvent"("applicationId");
CREATE INDEX "ApplicationEvent_scheduledAt_idx" ON "ApplicationEvent"("scheduledAt");
CREATE INDEX "JobAlert_userId_idx" ON "JobAlert"("userId");
CREATE INDEX "JobAlert_isActive_lastRunAt_idx" ON "JobAlert"("isActive", "lastRunAt");
ALTER TABLE "QuestionAnswer" ADD CONSTRAINT "QuestionAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationEvent" ADD CONSTRAINT "ApplicationEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAlert" ADD CONSTRAINT "JobAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAlert" ADD CONSTRAINT "JobAlert_savedSearchId_fkey" FOREIGN KEY ("savedSearchId") REFERENCES "SavedSearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Do not backfill nullable timestamps. Existing rows receive `false`, `relevance`, and `0` only through defaults. Do not use `db push` in deployment; run `prisma migrate deploy` after generating the client.

### Step 3 - Validation and application/event routes (sequential after Step 1)

Modify `backend/src/shared/validation.ts`:

* Extend `updateApplicationSchema` with `followUpAt`, `ghostedAt`, and `withdrawnAt` as `z.string().datetime().nullable().optional()` so clients can set or clear each value. Keep existing status enum unchanged; `withdrawn` is represented by `withdrawnAt` and an event, not a breaking status change.
* Add schemas with these exact limits: question `1..500`, answer `1..20000`, category enum `behavioral|technical|situational|general` optional nullable, notes `max 2000` nullable optional, tags array of strings max 20 and each max 50; event type enum `status_change|note_added|follow_up|interview_scheduled|offer_received|rejected|withdrawn`, applicationId UUID, title max 200, description max 10000, scheduledAt/completedAt nullable ISO datetimes; alert name `1..100`, query `1..200`, location max 100 nullable, sources max 10 strings, minMatchScore integer 0..100 nullable, remoteOnly boolean, isActive boolean, last-run fields server controlled, notify flags booleans.

Modify `backend/src/routes/applications.ts`:

* On create, keep the current listing/tailored-resume ownership checks and create a `status_change` event only when a non-default initial status is supplied. Do this transactionally with `prisma.$transaction`; event `toStatus` is the created status.
* On PATCH, accept the three timestamp fields. Build `data` with `!== undefined` checks so null clears a timestamp. When status changes, create one `status_change` event with old/new status in the same transaction. Return the updated application and include its ordered events (`createdAt asc`) in GET/PATCH responses. Never accept `userId` from input.
* Add `GET /:id/events`, `POST /:id/events`, and `PATCH /:id/events/:eventId`. Every handler loads the application, calls `ensureOwnership`, and for event mutation verifies the event belongs to that application. `POST` sets only validated event fields plus `applicationId`; `PATCH` permits only title, description, scheduledAt, completedAt. Use `NotFoundError('Application')`/`NotFoundError('Application Event')` and existing `handleApiError`.

### Step 4 - Q&A bank routes (independent of Steps 3 and 5 after schema)

Create `backend/src/routes/question-answers.ts` and mount it as `router.use('/question-answers', questionAnswersRoutes)` in `backend/src/routes/index.ts`.

Endpoints and exact behavior:

* `GET /api/question-answers?category=&q=`: authenticated; filter `{ userId }`, optional exact category, optional case-insensitive PostgreSQL `contains` on question or answer; order `updatedAt desc`.
* `POST /api/question-answers`: authenticated; create with server `userId`; return 201.
* `PATCH /api/question-answers/:id`: authenticated; ownership check; update only supplied fields; return 200.
* `DELETE /api/question-answers/:id`: authenticated; ownership check; return 204.

No endpoint may query or mutate another user's Q&A. Use Prisma JSON assignment (`tags: tags ?? null`) and do not cast arbitrary request bodies to `any`.

### Step 5 - Saved-search and alert routes (independent of Step 4 after schema)

Modify `backend/src/routes/saved-searches.ts` and `backend/src/shared/validation.ts`:

* Expand create/update inputs with `minMatchScore`, `remoteOnly`, and `sortBy` (`relevance|date|company|matchScore`). Preserve `boards` as the transport name and store it in `sources`.
* Add missing `PATCH /api/searches/:id`, ownership-checking before update. Do not let clients set `lastRunAt` or `matchCount`.
* In `POST /:id/run`, apply the saved location/company/remote/min-score/sort filters to results, then update that saved search in the same request: `lastRunAt: new Date()`, `matchCount: returned.length`. Preserve current board ownership filtering and per-source failure fallback. Do not claim match scores that the source result does not provide.

Create `backend/src/routes/job-alerts.ts`, mount `/alerts`, and implement:

* `GET /api/alerts`: current user's alerts, `createdAt desc`.
* `POST /api/alerts`: create server-owned alert; optional `savedSearchId` must belong to current user; copy no fields implicitly except explicitly supplied.
* `PATCH /api/alerts/:id`: ownership check; update alert configuration and `isActive`; never allow client changes to `lastRunAt`/`lastMatchCount`.
* `DELETE /api/alerts/:id`: ownership check, 204.
* `POST /api/alerts/:id/run`: ownership check; reuse the saved-search source resolution only when `savedSearchId` exists, otherwise resolve the alert's `sources`; update `lastRunAt` and `lastMatchCount` after successful scan. A source failure is treated as an empty result as in existing routes; total unexpected errors use `handleApiError` and do not update run metadata.

### Step 6 - Job comparison endpoint (independent after schema)

Modify `backend/src/routes/jobs.ts`, placing the route before `router.get('/:id', ...)`:

`GET /api/jobs/compare?ids=<uuid>,<uuid>[,<uuid>...]`

Require auth, parse 2-4 unique UUIDs, return 400 for malformed, duplicate, too few, or too many IDs. Fetch with `findMany({ where: { id: { in: ids } }, select: { id, source, title, company, location, description, applyUrl, postedAt, expiresAt, isActive, lastVerifiedAt } } })`; return 404 if any requested ID is absent. Return results in the same order as `ids`. This is a comparison projection, not a new table and not a write. Add no comparison relation to Prisma.

### Step 7 - Frontend contracts (independent after API shape)

Modify `src/services/api/jobs.ts` (the actual existing client file), `src/services/api/index.ts`, and `src/hooks/useJobs.ts`.

Add exact interfaces:

```ts
export interface QuestionAnswer { id: string; question: string; answer: string; category?: 'behavioral'|'technical'|'situational'|'general' | null; notes?: string | null; tags?: string[] | null; createdAt: string; updatedAt: string; }
export type ApplicationEventType = 'status_change'|'note_added'|'follow_up'|'interview_scheduled'|'offer_received'|'rejected'|'withdrawn';
export interface ApplicationEvent { id: string; applicationId: string; type: ApplicationEventType; fromStatus?: string | null; toStatus?: string | null; title?: string | null; description?: string | null; scheduledAt?: string | null; completedAt?: string | null; createdAt: string; }
export interface JobAlert { id: string; savedSearchId?: string | null; name: string; query: string; location?: string | null; sources?: string[] | null; minMatchScore?: number | null; remoteOnly: boolean; isActive: boolean; lastRunAt?: string | null; lastMatchCount: number; notifyInApp: boolean; notifyEmail: boolean; createdAt: string; updatedAt: string; }
export interface JobComparisonItem extends JobListingSummary { description: string; expiresAt?: string; lastVerifiedAt?: string; }
```

Extend `Application` with `followUpAt`, `ghostedAt`, `withdrawnAt`, and `events?: ApplicationEvent[]`. Extend `SavedSearch` with the five new fields and retain `boards` as the client alias. Add API methods `questionAnswersApi`, `alertsApi`, `applicationsApi.events/listEvents/createEvent/updateEvent`, and `jobsApi.compare(ids: string[])`. Export all types/services from `src/services/api/index.ts`. Add React Query hooks with query keys `['question-answers']`, `['alerts']`, and `['job-comparison', ids]`; mutations invalidate the corresponding list and application keys. Existing UI need not be redesigned for this schema task, but no client method may send server-controlled alert/search run fields.

### Step 8 - Tests and verification (sequential after implementation)

Add or extend these exact test files:

* `backend/src/routes/applications.test.ts`: assert timestamp set/null-clear behavior, one `status_change` event per actual transition, chronological event listing, cross-user denial, event/application mismatch rejection, and cascade deletion.
* `backend/src/routes/question-answers.test.ts`: assert authenticated CRUD, category/search filtering, validation limits, tags round-trip, and cross-user denial.
* `backend/src/routes/job-alerts.test.ts`: assert CRUD ownership, saved-search ownership validation, defaults, successful run metadata, and unchanged metadata after an unexpected scan failure.
* `backend/src/routes/saved-searches.test.ts`: assert new create/update fields, server-controlled run metadata, saved filters, and board ownership filtering.
* `backend/src/routes/jobs.test.ts`: assert comparison accepts exactly 2-4 UUIDs, rejects malformed/duplicate/out-of-range lists with 400, preserves requested order, returns 404 for a missing listing, and returns only the documented projection.
* `backend/prisma/schema.test.ts` (or the repository's existing Prisma schema test location): assert model/field/index presence by running Prisma validation and inspecting the migration. If no DB test harness exists, document that limitation rather than silently skipping migration verification.

Run from `backend` against a disposable PostgreSQL `DATABASE_URL`:

```text
npx prisma validate
npm run db:generate
npx prisma migrate deploy
npm run build
npm run test
```

Run the root frontend's existing typecheck/build script from `package.json` (inspect its script name first). Inspect `git diff --check` and the migration for absence of `DROP TABLE`, `DROP COLUMN`, destructive foreign-key actions, or a new required column without a default.

## CONSTRAINTS

* Only additive migrations. Never drop/rename existing columns, alter existing status values, delete existing rows, or introduce a required column without a default.
* Preserve existing paths and behavior in `applications.ts`, `saved-searches.ts`, and `jobs.ts` unless explicitly listed above. Keep all existing source failure handling and auth middleware.
* Do not touch `backend/src/services/api/jobs.ts` because it does not exist. Do not touch `JobListing`, `User` scalar fields, or unrelated Prisma models beyond the specified relation arrays.
* Every new/mutating route uses `requireAuth`, Zod `validateInput`, ownership checks, and `handleApiError`. Avoid circular imports: routes may import Prisma, validation, auth, and errors; validation must not import routes or Prisma.
* Do not expose `passwordHash`, API keys, or another user's records in any new response.

## VERIFIED

* Read the full `backend/prisma/schema.prisma` (446 lines). HEAD has no requested models; the working tree draft has the requested additions but uses capitalized `User` relation field names and is not backed by a migration.
* Read `backend/src/routes/applications.ts` (79 lines), `saved-searches.ts` (94 lines), `jobs.ts` (225 lines), `backend/src/routes/index.ts`, and `backend/src/shared/validation.ts`.
* Confirmed `backend/src/services/api/jobs.ts` is absent. Confirmed the actual frontend service is `src/services/api/jobs.ts`; existing application/search client methods do not expose the new fields.
* Confirmed there is no tracked `backend/prisma/migrations` directory in the inspected tree.
* Confirmed `git status --short` already reports unrelated working-tree modifications in `backend/package.json`, `backend/package-lock.json`, `backend/src/index.ts`, `backend/src/load-env.ts`, and `backend/prisma/schema.prisma`; implementation must not discard them.
* Existing verification commands from `backend/package.json` are `npm run build`, `npm run test`, `npm run db:generate`, `npm run db:migrate`, and `npm run db:push`; deployment must use `prisma migrate deploy` rather than `db push`.

## RISKS

* The current worktree schema appears to be a partial prior implementation. Before editing, compare it to this specification and preserve any intended compatible additions, but fix relation names and add the migration/API coverage.
* Prisma's exact SQL for `String @default(uuid())` and `@updatedAt` can vary by Prisma version. Generate the migration with the pinned Prisma 5.22 CLI, inspect it, and require the resulting SQL to be semantically equivalent to Step 2.
* `JobListing` is globally shared, so database ownership cannot restrict comparison to a user without a prohibited new field. The bounded authenticated read is intentional; if privacy requirements change, add an explicit authorization design before implementation.
* Alert scheduling/email delivery is outside this schema task. The records and run endpoint must be implemented, but no background scheduler or email sender should be invented here.

## Acceptance criteria

1. `prisma validate` and `prisma generate` succeed with all three models, all specified fields, relations, indexes, and delete actions.
2. Migration contains only additive `ALTER TABLE ADD COLUMN`, `CREATE TABLE`, indexes, and foreign keys; applying it preserves pre-existing rows and defaults new fields as specified.
3. Authenticated CRUD and ownership tests pass for Q&A, alerts, application events, and saved-search updates; cross-user access returns 403/404 according to existing error conventions.
4. Application timestamp set/clear behavior works, status changes produce exactly one timeline event, and deleting an application cascades its events.
5. Saved-search runs update `lastRunAt`/`matchCount`; alert runs update their metadata only after a successful overall run.
6. Comparison validates 2-4 IDs, returns ordered projections, and has no database write.
7. Frontend TypeScript can import every new type/service and existing jobs/applications/search flows remain type-safe.

## Implementor must verify checklist

- [ ] Preserve unrelated working-tree changes and all pre-existing Prisma models/fields.
- [ ] Reconcile `backend/prisma/schema.prisma` to the exact models/fields/relations above.
- [ ] Generate and inspect the additive migration SQL and apply it against a disposable PostgreSQL database.
- [ ] Add validation, routes, mounts, ownership checks, transaction/event behavior, and controlled run metadata exactly as specified.
- [ ] Add frontend interfaces, API methods, exports, and React Query keys/hooks without sending server-controlled fields.
- [ ] Add route/schema tests for happy paths, invalid input, cross-user access, cascades, timestamp clearing, comparison bounds/order, and run metadata.
- [ ] Run `npm run db:generate` and `npm run build` from `backend`; run `npm run test` from `backend`; run the repository's frontend typecheck/build command if present.
- [ ] Confirm `git diff` contains no destructive SQL, no unrelated formatting sweep, and no edits to the nonexistent backend service path.
