# Clearance single-application-password authentication

## OBJECTIVE

Replace the current multi-user JWT, signup, Google OAuth, email-verification, and password-reset system with one self-hosted application password. The password is read only from `CLEARANCE_ACCESS_PASSWORD` (default `CHANGEME`), and successful login creates a server-side opaque session represented by an HTTP-only cookie. Existing domain data remains usable by retaining one canonical `User` row as the ownership identity.

This is a single-instance authentication change, not an invitation or account-management feature. There is no registration, user password stored in the database, OAuth identity, email verification, or password recovery flow after this change.

## ARCHITECTURE DECISIONS

1. **Retain `User` as a singleton ownership row.** Every existing domain table uses `userId`; replacing those relations with no user identity would unnecessarily change every route and query. Authentication resolves the one canonical row and continues to populate `req.user.id`, so existing ownership checks remain defense in depth.
2. **Use a database-backed opaque session, not JWT.** Generate 32 random bytes with `crypto.randomBytes`, store only SHA-256(token) in `Session`, and put the raw token only in an HTTP-only cookie. Middleware checks existence and expiry on every request. This permits logout and session revocation and avoids bearer tokens in API responses/local storage.
3. **Compare the configured password without persisting it.** Hash the submitted and configured strings with SHA-256 and compare the digests with `crypto.timingSafeEqual`; do not use the legacy `User.passwordHash` or bcrypt for application access.
4. **Preserve the existing profile endpoints and UI fields that are useful to the singleton.** `/auth/me` and `/auth/profile` continue to support profile display/editing. Account deletion is removed because deleting the singleton would orphan the instance's ownership identity and there is no replacement registration flow.
5. **Treat the singleton as admin.** `req.user.isAdmin` is always `true`, preserving the existing admin route without email allowlists. `admin.ts` itself does not need a behavioral change.
6. **Do not expose the configured password or session token.** Login returns the sanitized user only. The cookie name is changed from `token` to `clearance_session`, invalidating all old JWT cookies.

Rejected alternatives: stateless signed cookies (cannot revoke individual sessions), browser local storage (XSS exposure), and removing `User`/all ownership columns (large unrelated data migration and loss of existing route safeguards).

## EXACT FILE PLAN

### Modify

- `backend/src/config/env.ts`
  - Remove `JWT_SECRET`, `ADMIN_EMAILS`, `ALLOW_REGISTRATION`, and their parsing/helpers (`getAdminEmails`, `getAllowRegistration`).
  - Add `CLEARANCE_ACCESS_PASSWORD: z.string().default('CHANGEME')`, include `process.env.CLEARANCE_ACCESS_PASSWORD` in the parse input, and export it through `env`.
  - Change `assertRequiredRuntimeConfig` to have no JWT check. It may warn when the value is `CHANGEME`, but must not print the password. Keep unrelated URL/SMTP configuration intact (SMTP becomes unused by auth but may be used elsewhere).
- `backend/src/middleware/auth.ts`
  - Replace all JWT imports/types/functions and all Prisma user lookup by JWT payload with session logic.
  - Keep exported names `requireAuth`, `optionalAuth`, `clearAuthCookie` so all existing route imports remain stable. Replace `setAuthCookie` with `setSessionCookie(res, rawToken)` (or update its only auth-route caller consistently).
  - Add exact helpers: `hashSessionToken(token: string): string`, `createSessionToken(): string`, `getSessionToken(req: Request): string | undefined`, and `isAccessPasswordValid(password: string): boolean`.
  - Session cookie options: name `clearance_session`, `httpOnly: true`, `secure: env.NODE_ENV === 'production'`, `sameSite: 'lax'`, `maxAge: 7 * 24 * 60 * 60 * 1000`, and `path: '/'`. Clear the same name/options.
  - `requireAuth`: read cookie only (do not accept `Authorization: Bearer`), reject missing/unknown/expired sessions with status 401 and `{ error: 'Authentication required' }`, load the session's related user, set `req.user = { id, email, emailVerified: true, isAdmin: true }`, and call `next()`.
  - On a database/unexpected error log exactly `[Auth] Middleware error:` with the error and return 500 `{ error: 'Authentication error' }`.
  - `optionalAuth` may silently ignore absent/invalid/expired sessions; on a valid session populate the same request user. It must call `next()` even on lookup failure.
  - Delete expired sessions opportunistically only if this is implemented as a non-blocking cleanup; never make cleanup failure fail authentication.
- `backend/src/routes/auth.ts`
  - Rewrite the file to remove bcrypt, Google OAuth, crypto OAuth code, email helper imports, registration gating, seed-on-signup, and all signup/reset/verification/OAuth routes.
  - `POST /api/auth/login`: validate `{ password }` with the new `accessPasswordSchema`, return 401 `{ error: 'Invalid password' }` for missing/invalid password without logging the password, find the canonical singleton user (fail with 500 `{ error: 'Application user is not configured' }` if none), create a Session row with SHA-256 token hash and expiry 7 days, set the session cookie, and return `200 { user: sanitizeUser(user, true) }`. Log only a `login_failed` security event with reason `invalid_password`.
  - `POST /api/auth/logout`: delete the matching hashed session if present, clear `clearance_session`, and return `{ success: true }` even when no session exists.
  - `GET /api/auth/me`: keep `requireAuth`, fetch `req.user.id`, return `sanitizeUser(user, true)`, and return the existing NotFound error if the row disappeared.
  - Keep `PUT /api/auth/profile` with `requireAuth` and `updateProfileSchema`, returning `sanitizeUser(updatedUser, true)`.
  - Delete routes `POST /signup`, `DELETE /account`, `POST /forgot-password`, `POST /reset-password`, `POST /verify-email`, `GET /verify-email`, `POST /resend-verification`, `GET /google`, and `GET /google/callback`.
  - Use `handleApiError` for route errors. Import order must remain external packages, config/database, middleware, shared helpers/validation; do not reintroduce a circular import from middleware to routes.
- `backend/src/shared/validation.ts`
  - Replace the auth schema block with `export const accessPasswordSchema = z.object({ password: z.string().min(1, 'Password is required').max(200, 'Password too long') }).strict();`.
  - Delete `loginSchema`, `signupSchema`, and `resetPasswordSchema`, and their exported input types. Keep `updateProfileSchema` and all non-auth schemas unchanged.
- `backend/src/shared/auth.ts`
  - Keep `ensureOwnership`, `requireUser`, and `sanitizeUser` because the rest of the backend still uses them. Update `SanitizableUser`/`sanitizeUser` so `emailVerified` is either removed from the response contract or always returned as `true`; the preferred contract is to remove the field entirely and update frontend types/UI accordingly.
  - Keep ownership checks unchanged; a singleton identity still prevents accidental access to records with a different/invalid owner id.
- `backend/src/types/express.d.ts`
  - Remove `emailVerified?: boolean` from `Request.user`; retain `id`, `email`, and `isAdmin`.
- `backend/src/app.ts`
  - Remove `getAllowRegistration` import and `/api/config` registration/OAuth payload. Either remove `/api/config` entirely (preferred, because the frontend no longer calls it) or return only `{ authMode: 'password' }`; implement the preferred removal.
  - Keep general limiter and apply `authLimiter` only to `/api/auth/login`; remove signup and forgot-password limiters. Keep `credentials: true` and add no Authorization requirement to CORS.
- `backend/src/routes/admin.ts`
  - No code change required. Verify `requireAdmin` remains correct because middleware sets `isAdmin: true`. Do not replace it with a route-wide bypass.
- `backend/prisma/schema.prisma`
  - In `User`, remove `passwordHash`, `googleId`, `emailVerified`, `emailVerifyToken`, `emailVerifyExpires`, `passwordResetToken`, and `passwordResetExpires`; retain `id`, email/profile/timestamps and all domain relations.
  - Add after `User`:
    ```prisma
    model Session {
      id        String   @id @default(uuid())
      tokenHash String   @unique
      userId    String
      user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
      expiresAt DateTime
      createdAt DateTime @default(now())

      @@index([userId])
      @@index([expiresAt])
    }
    ```
  - Add `sessions Session[]` to `User`.
- `.env.example`
  - Replace the AUTH block with `CLEARANCE_ACCESS_PASSWORD="CHANGEME"` and remove Google, registration, admin, and JWT variables. Do not document a client-side password variable.
- `.env`
  - Remove the existing JWT/Google/registration/admin entries. Add `CLEARANCE_ACCESS_PASSWORD="CHANGEME"` only as a development placeholder; deployment operators must replace it with a strong secret. Do not copy existing credentials into documentation or commits.
- `src/services/api/auth.ts`
  - Change imports/types to password-only login. `AuthResponse` is `{ user: BackendUser }` with no token or verification flag.
  - `login({ password }: LoginCredentials)` posts exactly `{ password }` to `/auth/login`, transforms and returns the user.
  - Delete `signup`, `deleteAccount`, `forgotPassword`, `resetPassword`, `verifyEmail`, `resendVerificationEmail`, and `getGoogleAuthUrl`. Keep `logout`, `getCurrentUser`, and `updateProfile`.
  - Remove `emailVerified` from `BackendUser`/transformation if removed from backend response.
- `src/types/auth.ts`
  - Make `LoginCredentials` contain only `password: string`.
  - Delete `SignupCredentials` and `SignupResult`; remove `emailVerified` from `User` and retain `isAdmin`/profile fields only if still consumed.
- `src/pages/Auth.tsx`
  - Replace tabs, email/name/signup form, config fetch, forgot-password link, Google buttons, Chrome/Mail/User imports, and signup handler with one password form.
  - Use `authApi.login({ password })`, cache `authKeys.user`, show a generic login failure toast, and navigate to `/app/resumes` on success.
  - Preserve show/hide password and loading state. Label the page “Enter application password” and state that this is the password configured by the instance administrator. Do not render password requirements that are not enforced by env config.
- `src/hooks/useAuth.ts`
  - Keep `useCurrentUser`, `useAuth`, `useLogin`, `useLogout`, and `useUpdateProfile`.
  - Delete signup, forgot/reset, resend-verification, and delete-account hooks. `useLogin` takes the new password-only credentials.
- `src/hooks/index.ts`
  - Remove exports for deleted auth hooks; retain current-user/auth/login/logout/update-profile/authKeys exports.
- `src/pages/Settings.tsx`
  - Remove imports, mutation setup, UI, and handlers for account deletion and verification/resend. Remove all `emailVerified` branches. Keep singleton profile editing and logout. The email display is read-only informational identity, not a login field.
- `src/App.tsx`
  - Delete lazy imports and public routes for `ForgotPassword`, `ResetPassword`, and `VerifyEmail`. Keep `/auth`, terms, privacy, and protected app routes unchanged.
- `src/pages/ForgotPassword.tsx`, `src/pages/ResetPassword.tsx`, `src/pages/VerifyEmail.tsx`
  - Delete these files.
- `backend/src/auth/email.ts`
  - Delete this file; no auth email helper or auth SMTP dependency remains.
- `backend/package.json` and `backend/package-lock.json`
  - Remove direct dependencies `bcryptjs`, `google-auth-library`, and `jsonwebtoken`, plus their direct type packages (`@types/bcryptjs`, `@types/jsonwebtoken`). Run the package manager to regenerate the lockfile rather than hand-editing transitive entries.
- `backend/src/routes/api.smoke.test.ts`
  - Replace the signup validation test with a missing-password login assertion (`POST /api/auth/login` with `{}` => 400).
  - Add login/session/logout assertions with a mocked Prisma/config boundary or an isolated test database fixture (never the production database URL): wrong password => 401; correct password => 200 with `user` and no `token`; response sets `clearance_session` with `HttpOnly`; `/auth/me` succeeds with the cookie; logout returns success and the same cookie no longer authenticates.
  - Add removed-route assertions: signup, forgot-password, reset-password, verify-email, resend-verification, and Google path all return 404.
  - Keep the existing health, unauthenticated resume, payment 404, and export validation tests.
- `backend/src/test/setup.ts`
  - Set `process.env.CLEARANCE_ACCESS_PASSWORD = process.env.CLEARANCE_ACCESS_PASSWORD || 'test-access-password'`; remove JWT test setup.

### Create

- `backend/prisma/migrations/20260824_remove_multi_user_auth/migration.sql` (or the exact timestamped Prisma migration directory generated by the implementor). Use the SQL in the migration section below.
- `backend/src/middleware/auth.test.ts`: create this required unit-test file. Test password comparison, cookie extraction, expired/unknown session rejection, valid session population, and optional-auth continuation with mocked Prisma/config dependencies.

### Delete

`backend/src/auth/email.ts`; `src/pages/ForgotPassword.tsx`; `src/pages/ResetPassword.tsx`; `src/pages/VerifyEmail.tsx`.

Do not delete `User`, `shared/auth.ts`, `admin.ts`, profile/settings pages, ownership checks, or the `AIProviderKey`/domain tables.

`src/components/ProtectedRoute.tsx` requires no source change: its existing React Query/401 redirect behavior is still the desired behavior with sessions.

## DATABASE AND MIGRATION

Take a PostgreSQL backup before migration. The migration must be transactional and preserve all data under one canonical user. The following SQL is the required data phase before Prisma drops legacy columns; quote identifiers exactly as shown:

```sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  canonical_id text;
BEGIN
  SELECT id INTO canonical_id FROM "User" ORDER BY "createdAt", id LIMIT 1;
  IF canonical_id IS NULL THEN
    INSERT INTO "User" (id, email, "createdAt", "updatedAt", name)
    VALUES (gen_random_uuid()::text, 'local@clearance.invalid', NOW(), NOW(), 'Clearance User')
    RETURNING id INTO canonical_id;
  END IF;

  UPDATE "UploadedFile" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "Resume" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "ATSReport" SET "userId" = canonical_id WHERE "userId" IS NOT NULL AND "userId" <> canonical_id;
  UPDATE "JobMatch" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  -- CareerProfile.userId is unique. Keep the canonical user's profile and
  -- discard duplicate profiles before collapsing their user ids.
  DELETE FROM "CareerProfile" WHERE "userId" <> canonical_id;
  UPDATE "JobBoard" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "SavedSearch" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "AIProviderKey" SET "userId" = canonical_id WHERE "userId" IS NOT NULL AND "userId" <> canonical_id;
  UPDATE "JobEvaluation" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "TailoredResume" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "Application" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "QuestionAnswer" SET "userId" = canonical_id WHERE "userId" <> canonical_id;
  UPDATE "JobAlert" SET "userId" = canonical_id WHERE "userId" <> canonical_id;

  DELETE FROM "User" WHERE id <> canonical_id;
END $$;

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User" DROP COLUMN "passwordHash";
ALTER TABLE "User" DROP COLUMN "googleId";
ALTER TABLE "User" DROP COLUMN "emailVerified";
ALTER TABLE "User" DROP COLUMN "emailVerifyToken";
ALTER TABLE "User" DROP COLUMN "emailVerifyExpires";
ALTER TABLE "User" DROP COLUMN "passwordResetToken";
ALTER TABLE "User" DROP COLUMN "passwordResetExpires";

COMMIT;
```

Before applying, inspect the live schema for any additional tables with a `userId` FK; add equivalent canonical reassignment statements before deleting duplicate users. Prisma migration must be applied with `npx prisma migrate deploy` in deployment and generated client with `npm run db:generate`. A rollback requires restoring the backup; the canonical merge is intentionally not reversible and old JWT cookies are intentionally invalid.

## API CONTRACT

Remaining endpoints:

| Method/path | Auth | Request | Response |
|---|---|---|---|
| POST `/api/auth/login` | public, rate-limited | `{ "password": string }` | `200 { user }`, or `401 { error: "Invalid password" }` |
| POST `/api/auth/logout` | public/idempotent | none | `200 { success: true }` |
| GET `/api/auth/me` | session | none | sanitized singleton user, or `401` |
| PUT `/api/auth/profile` | session | existing `updateProfileSchema` | sanitized singleton user |

Removed endpoints must return 404 through the normal router: signup, account deletion, forgot/reset password, verify/resend email, and both Google OAuth paths. No token appears in JSON, and no Authorization bearer token is accepted.

## FRONTEND FLOW

`useCurrentUser` calls `/auth/me`; a 401 maps to `null`, so `ProtectedRoute` continues to redirect to `/auth`. Login sends only the password and relies on the HTTP-only cookie. Logout clears the query cache. The frontend must not persist auth state or password in local storage/session storage. `/forgot-password`, `/reset-password`, and `/verify-email` must no longer be routable pages.

## IMPLEMENTATION ORDER

1. Back up database and add the Prisma migration/schema (backend-only, sequential before runtime deployment).
2. Change env parsing and backend session middleware/routes/validation; regenerate Prisma client.
3. Update app rate limits and remove public config/auth email/OAuth code; remove backend dependencies.
4. Update frontend types/API/hooks/pages/routes/settings.
5. Update tests, run typecheck/build/lint/test, then apply migration and perform smoke tests against the configured instance.

## VERIFICATION

Run from repository root:

```powershell
npm install
npm run lint
npm run build
```

Run backend from `backend`:

```powershell
npm install
npm run db:generate
npm run build
npm test -- --run
```

For a running local backend, verify exact behavior (replace URL as needed):

```powershell
curl.exe -i http://localhost:3001/api/auth/me
curl.exe -i -c "$env:TEMP\clearance-cookies.txt" -H "Content-Type: application/json" -d '{"password":"wrong"}' http://localhost:3001/api/auth/login
curl.exe -i -c "$env:TEMP\clearance-cookies.txt" -H "Content-Type: application/json" -d '{"password":"<CLEARANCE_ACCESS_PASSWORD>"}' http://localhost:3001/api/auth/login
curl.exe -i -b "$env:TEMP\clearance-cookies.txt" http://localhost:3001/api/auth/me
curl.exe -i -b "$env:TEMP\clearance-cookies.txt" -X POST http://localhost:3001/api/auth/logout
curl.exe -i -X POST -H "Content-Type: application/json" -d '{}' http://localhost:3001/api/auth/signup
curl.exe -i -X GET http://localhost:3001/api/auth/google
```

Assert: unauthenticated/me is 401; wrong login is 401; correct login is 200 with `Set-Cookie: clearance_session=...; HttpOnly` and no JSON token; me works only with that cookie; logout invalidates it; signup and Google are 404. Also query `SELECT COUNT(*) FROM "User";` (must be 1) and verify every reassigned domain row points to that one id.

## CONSTRAINTS

- Never log `CLEARANCE_ACCESS_PASSWORD`, submitted passwords, raw session tokens, JWT secrets, OAuth secrets, or database URLs.
- Keep `credentials: 'include'`, CORS credentials, all non-auth routes, and server-side ownership checks.
- Do not change public ATS scan behavior merely because it contains the word auth; only existing protected routes remain protected by the new middleware.
- Do not leave dead imports, lazy routes, env references, package dependencies, or UI links to removed flows.
- `CHANGEME` is the required default for compatibility but is unsafe for production; document and test that deployment replaces it.

## RISKS AND EDGE CASES

- **Existing multiple users:** migration merges all ownership rows into the earliest user and deletes other identities. This is required by single-instance semantics; backup first and communicate the destructive identity merge.
- **No users:** migration creates `local@clearance.invalid`; login remains possible without signup.
- **Legacy cookies:** old `token` JWT cookies are ignored and naturally expire; users must log in again.
- **Session replay/theft:** HTTPS in production, HTTP-only cookie, SameSite=Lax, hashed-at-rest token, expiry, logout deletion, and rate limiting mitigate risk. There is no CSRF token; SameSite plus strict CORS is the existing boundary. If deployment needs cross-site embedding, add CSRF protection rather than weakening SameSite.
- **Password changes:** changing the environment password invalidates no existing sessions. The implementor should either document restart plus continued session validity, or add startup/session-version invalidation; do not invent an endpoint. Recommended behavior is to leave active sessions valid until expiry/logout because no password-change API exists.
- **Default password:** anyone reaching a fresh instance can use `CHANGEME`; production deployment must replace it before exposure.
- **Concurrent logins:** multiple sessions are allowed for the same singleton; logout removes only the current session.
- **Prisma migration safety:** if the live database has tables not present in the inspected schema, migration must be amended before deleting duplicate users. Restore backup if migration fails.

## ACCEPTANCE CRITERIA / IMPLEMENTOR MUST VERIFY

- [ ] `CLEARANCE_ACCESS_PASSWORD` is the only auth secret, defaults to `CHANGEME`, and is never sent to the client.
- [ ] JWT, Google OAuth, signup/registration, email verification, reset, and resend flows and dependencies are removed.
- [ ] Session rows contain only token hashes, have expiry/user indexes, and cascade with the singleton user.
- [ ] The migration leaves exactly one canonical `User` and preserves/reassigns all listed domain data.
- [ ] Login accepts only `{password}`, rate limits failures, sets an HTTP-only `clearance_session`, and returns no token.
- [ ] Middleware rejects missing/expired/unknown sessions, populates `req.user`, and protects every previously protected route.
- [ ] Logout revokes the current session and is idempotent.
- [ ] Profile/admin/ownership behavior still works under the singleton identity; account deletion and email-verification UI do not exist.
- [ ] Removed frontend files/routes/API methods have no references, and `npm run lint`, `npm run build`, `npm run db:generate`, backend build, and backend tests pass.
- [ ] Manual curl checks prove 401/200/404 behavior and database checks prove singleton ownership.

## VERIFIED

Planning inspection confirmed:

- JWT cookie and Prisma user lookup are in `backend/src/middleware/auth.ts`; auth routes and all removed flows are in `backend/src/routes/auth.ts`.
- Required env currently includes JWT, Google, registration, and admin variables in `.env` and `.env.example`; `backend/src/config/env.ts` enforces JWT.
- All listed domain resources retain `userId` relations to `User` in `backend/prisma/schema.prisma`.
- Frontend auth is routed from `src/App.tsx`, implemented by `src/pages/Auth.tsx`, `src/hooks/useAuth.ts`, and `src/services/api/auth.ts`; reset/verification pages are separately routed.
- `src/pages/Settings.tsx` consumes verification and account deletion hooks and must be updated even though it was not in the initial requested file list.
- `backend/src/routes/api.smoke.test.ts` currently asserts signup and unauthenticated protection; it requires replacement assertions.
- No `backend/prisma/migrations` directory was present during inspection, so the migration is specified as a new first tracked migration. The implementor must check the actual deployed database migration history before applying it.
- No application source was modified while planning; this document is the sole deliverable.
