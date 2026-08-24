# Frontend Information Architecture and Navigation Specification

## OBJECTIVE

Reorganize the authenticated application navigation around the user's workflow (build a resume, discover jobs, optimize, and maintain a career profile), make Job Search the primary next step after resume creation, and add the missing Q&A Bank entry point. Add contextual links between the existing resume, ATS, job, and profile workflows without changing the existing visual theme, colors, typography, or backend contracts.

## VERIFIED CURRENT STATE

The following was inspected in the repository before writing this specification:

- `src/App.tsx`: public routes and authenticated routes are declared individually. Existing authenticated routes include `/app/resumes`, `/app/build`, `/app/match`, `/app/jobs`, `/app/jobs/:id`, `/app/profile`, `/app/applications`, `/app/settings`, `/app/ats-scan`, `/app/ats-history`, and `/app/admin`.
- `src/components/layout/AppLayout.tsx`: the sidebar is a flat `baseNavItems` array, desktop collapse is stateful, mobile visibility is stateful, and mobile overlay/header already exist. Links are rendered with `Link`, active state is computed from `location.pathname`, and the search input has no behavior.
- Every authenticated page inspected wraps its content in `AppLayout`: `Resumes`, `Build`, `ATSScan`, `ATSHistory`, `Jobs`, `JobDetail`, `Match`, `Applications`, `Profile`, `Settings`, and `Admin`.
- `src/pages/Resumes.tsx`: resume cards navigate to `/app/build/:resumeId`; cards currently have an invisible-on-default action menu and no matching-jobs CTA.
- `src/pages/ATSScan.tsx`: completed reports have Past Scans and Scan Another Resume actions, but no matching-jobs CTA.
- `src/pages/ATSHistory.tsx`: selected reports can open `/app/build/:resumeId`; its New Scan and empty-state links incorrectly use `/ats-scan` rather than the authenticated `/app/ats-scan` path.
- `src/pages/Jobs.tsx`: Job Search already has a Match jobs to your resume action, profile completion CTA, and job cards that navigate to `/app/jobs/:id` for evaluation.
- `src/pages/JobDetail.tsx`: evaluation and `TailorPanel` already provide the job-to-tailored-resume workflow, but the page needs explicit, discoverable labeling and responsive action layout.
- `src/pages/Profile.tsx`: the page is already titled Career Profile and has a button that navigates to `/app/jobs`; that navigation should be surfaced as a primary Discover jobs action rather than being only the form's Cancel action.
- `src/pages/Match.tsx`: this is the resume-to-job-description matching flow and currently creates a tailored resume. It does not read a resume ID from the URL.
- `src/services/api/jobs.ts` and `src/hooks/useJobs.ts`: Question Answer API types, list/create/update/delete API methods, and React Query hooks already exist. No Q&A page exists under `src/pages/`.
- `src/components/` contains the existing shadcn/Radix primitives, including `dialog`, `sheet`, `button`, `input`, `tooltip`, and `separator`; no new UI library is needed.
- `src/index.css`: the existing design tokens and IBM Plex Sans typography are already defined. They must not be changed for this work.
- `package.json`: the available verification scripts are `npm run build` and `npm run lint`; there is no configured frontend unit-test runner.
- `npm run build` was run against the current worktree and completed successfully. It emitted only the existing Browserslist notice and large-chunk warnings. `git status --short` showed unrelated pre-existing changes; do not overwrite or revert them.
- A review delegation was attempted but was unavailable because the delegation depth limit was reached. The implementation decisions below are therefore based on direct repository inspection.

## TARGET INFORMATION ARCHITECTURE

Use exactly this group order and item order in the authenticated sidebar. Group headings are non-interactive and are not links.

```
WORK
  My Resumes       /app/resumes
  Build            /app/build

JOBS
  Job Search       /app/jobs
  Applications     /app/applications
  Q&A Bank         /app/qa-bank

OPTIMISE
  ATS Scan         /app/ats-scan
  ATS History      /app/ats-history

PROFILE
  Career Profile   /app/profile

SYSTEM
  Settings         /app/settings
```

Use the existing Admin item only for admin users, after the SYSTEM group (or in a separate `ADMIN` group if a group heading is needed). It must not appear for non-admin users. Keep `/app/match` available as a protected contextual workflow route, but do not add it as a duplicate primary sidebar item: the primary discovery destination is `/app/jobs`, while matching remains reachable from Job Search and contextual CTAs.

The labels are intentionally changed from `Profile` to `Career Profile`. This is a navigation-label change only; preserve the existing `/app/profile` route and `Profile.tsx` component name.

## ARCHITECTURE DECISIONS

1. Keep route paths stable for all existing features. Add only `/app/qa-bank`; do not rename `/app/match` to `/app/jobs/match` because existing pages, landing links, and direct bookmarks use `/app/match`.
2. Represent groups as data in `AppLayout.tsx`, not as separate hard-coded nav blocks. This gives one source of truth for label, href, icon, group, and prominence state and prevents active-state drift.
3. Make Job Search prominent with a semantic link and a distinct existing variant/class treatment, but do not introduce new colors, fonts, gradients, or a redesign. Prominence means visual hierarchy within the existing token system, position first in JOBS, and a short supporting accessible label—not a new theme.
4. Use normal links for navigation and native buttons for actions. Do not implement a custom div-based navigation or a custom keyboard roving-tabindex pattern; standard links provide reliable Tab/Shift+Tab, Enter, browser history, and screen-reader behavior.
5. Treat the mobile sidebar as a modal navigation surface: opening moves focus into it, Escape closes it, closing restores focus to the menu button, and background content is not reachable while it is open. Reuse the existing overlay and animation; do not replace the entire layout with a new visual component.
6. Pass resume context to matching through `/app/match?resumeId=<id>`. Update `Match.tsx` to initialize its selected resume from that parameter, while retaining its existing manual Select behavior. If a source has no resume ID, link to `/app/match` without a query string.
7. Implement Q&A Bank against the already-present `questionAnswersApi` and hooks. Do not add backend endpoints, database migrations, or new API shapes in this frontend IA change.

## STEPS

### Step 1 - Add the Q&A route and page (sequential; prerequisite for sidebar link)

Modify `src/App.tsx`:

- Add `const QABank = lazy(() => import("./pages/QABank"));` beside the other lazy page imports.
- Add a protected route immediately after Applications (or alongside the other `/app/*` feature routes):

```tsx
<Route path="/app/qa-bank" element={
  <ProtectedRoute>
    <QABank />
  </ProtectedRoute>
} />
```

- Preserve every existing route and redirect.
- The current file references `<Admin />`; ensure the existing `Admin` page is imported/lazy-loaded as `const Admin = lazy(() => import("./pages/Admin"));` before the route if it is not already present in the implementation being edited. This is a narrowly scoped route-integrity fix, not an Admin feature change.

Create `src/pages/QABank.tsx`:

- Export a default `QABankPage` component and wrap it in `AppLayout`.
- Use the existing `useQuestionAnswers`, `useCreateQuestionAnswer`, `useUpdateQuestionAnswer`, and `useDeleteQuestionAnswer` hooks from `src/hooks/useJobs.ts` (use the exact exported names present when implementing; do not duplicate API calls in the page).
- Render a page heading `Q&A Bank`, a short description such as `Prepare answers for common interview questions`, a search input, a category filter, an Add question button, and a responsive list/grid of saved entries.
- Each entry must expose the question as a heading, answer text, optional category/tags, Edit, and Delete actions. Delete must use the existing destructive confirmation primitive (`AlertDialog`) or an equivalent accessible confirmation; never delete immediately on an accidental card click.
- The add/edit form must have explicit labels and validation: question and answer are required; category, notes, and tags are optional. Submit through the existing mutations, close the dialog on success, and leave it open with an inline error/toast on failure. Do not invent persistence fields beyond the existing `QuestionAnswer` interface (`question`, `answer`, `category`, `notes`, `tags`).
- Include loading, error, and empty states. Error state must provide a retry action via React Query refetch if the hook exposes it; otherwise use the hook's existing query invalidation/retry behavior and a clear error message.
- Ensure dialog focus is managed by the existing Radix dialog components. The page's search and category controls must work with the existing hook filter shape (`{ q?: string; category?: string }`). Avoid changing global CSS.

### Step 2 - Replace the flat sidebar with grouped navigation (sequential; modifies `src/components/layout/AppLayout.tsx`)

Replace `baseNavItems` with typed grouped data. The implementation should be equivalent to:

```tsx
type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  prominent?: boolean;
};

type NavGroup = {
  label: "WORK" | "JOBS" | "OPTIMISE" | "PROFILE" | "SYSTEM" | "ADMIN";
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  { label: "WORK", items: [
    { label: "My Resumes", href: "/app/resumes", icon: FolderOpen },
    { label: "Build", href: "/app/build", icon: FileText },
  ] },
  { label: "JOBS", items: [
    { label: "Job Search", href: "/app/jobs", icon: Briefcase, prominent: true },
    { label: "Applications", href: "/app/applications", icon: KanbanSquare },
    { label: "Q&A Bank", href: "/app/qa-bank", icon: MessageSquare },
  ] },
  { label: "OPTIMISE", items: [
    { label: "ATS Scan", href: "/app/ats-scan", icon: ScanSearch },
    { label: "ATS History", href: "/app/ats-history", icon: History },
  ] },
  { label: "PROFILE", items: [
    { label: "Career Profile", href: "/app/profile", icon: UserCog },
  ] },
  { label: "SYSTEM", items: [
    { label: "Settings", href: "/app/settings", icon: Settings },
  ] },
];
```

Import `LucideIcon` from `lucide-react` and `MessageSquare` (or another semantically appropriate existing Lucide icon). Do not add an icon package.

Build the visible groups by appending an Admin group/item only when `user?.isAdmin` is true. Preserve the existing `useAuth`, `useLogout`, and logout redirect behavior.

For each group:

- Render `<nav aria-label="Application navigation">` once, with a group `<div>` and an accessible heading element. Use `id` plus `aria-labelledby` on each group container if using a `role="group"`.
- Group headings are hidden when `collapsed` is true, but do not remove the navigation landmarks or links. In collapsed mode, preserve vertical spacing between groups so grouping remains perceivable through tooltips and DOM order.
- Use `NavLink` from `src/components/NavLink.tsx` (or `Link` with equivalent exact active logic) so active styling covers descendants. The active predicate must remain `pathname === href || pathname.startsWith(href + "/")`; this is required for `/app/jobs/:id` and `/app/build/:resumeId`.
- Add `aria-current="page"` on the active item. If using React Router `NavLink`, rely on its active semantics or set this explicitly through its render/class callback, but do not produce duplicate conflicting values.
- In collapsed mode each icon-only item must have `aria-label={item.label}` and `title={item.label}`. The text span must be absent or visually hidden without making a duplicate screen-reader label.
- The Job Search item must retain its accessible name `Job Search`; its `prominent` styling may use only existing `bg-primary`, `text-primary-foreground`, `ring`, `shadow`, `font-medium`, and spacing utilities. Do not hard-code a new color.
- All icon-only controls (collapse, mobile close, mobile menu, collapsed search, logout, theme toggle) need accessible names. Add `aria-label`, `aria-expanded` where applicable, and `aria-controls` linking the mobile menu button to the sidebar ID.
- Add a visible `sr-only` skip link before the layout/sidebar that targets a stable `main` ID, e.g. `<a href="#app-main" className="sr-only focus:not-sr-only ...">Skip to main content</a>`. The focus styles may use existing ring utilities only.
- Change `<main>` to include `id="app-main"`, `tabIndex={-1}`, and an accessible label such as `aria-label="Main content"`. Do not put `tabIndex={0}` on every page or card.

Keyboard and focus behavior in `AppLayout.tsx`:

- Add `useEffect`, `useRef`, and the minimum event handling needed. The mobile menu button must receive a ref.
- When `sidebarOpen` changes from false to true, focus the first visible navigation link (or the close button if there are no links) after the sidebar is mounted. When it changes to false after being open, restore focus to the menu button if it is still mounted.
- While the mobile sidebar is open, handle `Escape` at the sidebar/overlay level to close it. Do not prevent Escape inside child dialogs; Radix dialogs own their Escape behavior. If implementing a focus trap, cycle Tab from the last focusable sidebar control to the first and Shift+Tab from first to last; otherwise use the existing Radix `Sheet`/`Dialog` primitive rather than an incomplete custom trap. The chosen behavior must prevent focus moving to the obscured main content.
- Close the mobile sidebar on navigation click, as today. Do not close the desktop sidebar on navigation.
- The desktop collapse control must have `aria-expanded={!collapsed}`, `aria-controls="app-sidebar"`, and a label that changes between `Collapse navigation` and `Expand navigation`. Collapsing must not unmount links or remove their keyboard reachability.
- Do not assign arrow-key behavior to ordinary navigation links. Arrow keys should continue to scroll unless focus is in a native select/dialog component. This avoids conflicting with browser and assistive technology expectations.
- Honor `prefers-reduced-motion` by disabling or shortening the existing framer-motion sidebar/link animation. Keep animation behavior otherwise unchanged and do not add theme changes.

Responsive behavior in `AppLayout.tsx`:

- At `< lg` retain a full-width mobile header and off-canvas sidebar. The header menu button is the first focusable control, has `aria-label="Open navigation"`, `aria-expanded={sidebarOpen}`, and `aria-controls="app-sidebar"`.
- At `lg` and above retain the static sidebar and desktop collapse control. The collapsed width remains the existing `72` and expanded width remains `256`; do not change the breakpoint or theme.
- On mobile, the sidebar width remains usable for full labels (use the current expanded width or a responsive equivalent); it must not open in collapsed/icon-only mode. Reset/ignore `collapsed` while below `lg` so labels are always available.
- The overlay must be a button-like accessible dismissal surface or have `aria-hidden` and leave dismissal to the named close button/Escape. It must not become an unlabeled focusable element. Add `aria-hidden="true"` if it remains a non-interactive motion div.
- Main page headers and action rows must wrap rather than overflow horizontally on narrow widths. The sidebar change must not force horizontal scrolling in `AppLayout`.

Do not make the existing sidebar search appear functional unless a real search implementation is added. If it remains, give it an accurate accessible label and preserve its current visual appearance; do not imply it searches the application when it does not.

### Step 3 - Add resume-to-jobs contextual links (independent after Step 2)

Modify `src/pages/Resumes.tsx`:

- In each resume card's action area, add a visible secondary native `Button` or `Link` labeled `Find matching jobs` with an appropriate icon and `to={`/app/match?resumeId=${encodeURIComponent(resume.id)}`}`.
- Stop propagation for this control so it does not also open the card's editor click handler.
- Retain Edit/Duplicate/Create Variant/Archive/Delete behavior. The card itself should remain keyboard-accessible: either convert the card navigation to a real link structure or add a keyboard-operable control; do not rely only on `onClick` on a non-interactive `Card`.
- On small screens, action controls must wrap and remain visible; do not rely on hover-only visibility for the new CTA.

Modify `src/pages/Match.tsx`:

- Import `useSearchParams` and read `resumeId` once on mount.
- Initialize `selectedResumeId` from the query value only if it matches one of the loaded user resumes. If it does not match, clear/ignore it and retain the existing Select placeholder. Do not trust the query value for authorization; the existing API/user-owned resume list is the source of truth.
- Keep uploaded-file selection mutually exclusive with builder resume selection.
- Add `aria-describedby`/visible context that identifies when the page was opened for a specific resume, without changing the existing match API.

### Step 4 - Add ATS-report-to-jobs links (independent after Step 2)

Modify `src/pages/ATSScan.tsx`:

- In the completed report action row, add a prominent-but-existing-theme `Link`/button labeled `Find matching jobs` targeting `/app/match`.
- If the returned `result.resumeId` exists, target `/app/match?resumeId=${encodeURIComponent(result.resumeId)}`; otherwise target `/app/match` and let the user select a resume. Preserve Past Scans and Scan Another Resume.
- Use a real link for navigation so keyboard activation and browser history work. Ensure the mobile action row wraps.

Modify `src/pages/ATSHistory.tsx`:

- In the selected report view, add `Find matching jobs` beside `Open in Editor` when `selected.resumeId` exists, using `/app/match?resumeId=...`; without a resume ID, link to `/app/match`.
- Fix the existing New Scan and empty-state destinations from `/ats-scan` to `/app/ats-scan`.
- Preserve the in-page Back to history behavior and make the action row wrap on mobile.

### Step 5 - Make job-to-tailor navigation explicit (independent after Step 2)

Modify `src/pages/JobDetail.tsx` and, only if needed for the final label, `src/features/jobs/TailorPanel.tsx`:

- Keep the existing evaluate-then-tailor logic and `TailorPanel` props (`jobId`, `resumeId`, `evaluationId`, `jobDescription`). Do not replace the API calls.
- In the job detail action area, use a clear action label `Tailor resume to this job` for the existing tailoring action/panel. If a user has not evaluated yet, the action should explain that evaluation is required and focus/scroll to the resume selector/evaluate action rather than failing silently.
- After evaluation, make the TailorPanel heading/action discoverable and keyboard-operable. Preserve its existing successful creation flow to the builder.
- Use `useNavigate`/`Link` only for navigation; do not use `window.location`.
- Change the two-column content to stack at the existing responsive breakpoint (already `lg:grid-cols-2`) and ensure the job action controls wrap at narrow widths. Keep job description and evaluation content readable without horizontal overflow.

Modify `src/features/jobs/JobCard.tsx` only if a card-level CTA is needed to make the flow discoverable:

- Keep `Evaluate` as the primary card action because it opens JobDetail, where resume selection and tailoring occur.
- Do not add an unconnected tailor API call to a card. A card may say `Evaluate and tailor` only if it remains a navigation action to `/app/jobs/:id`.

### Step 6 - Add the profile-to-discovery link (independent after Step 2)

Modify `src/pages/Profile.tsx`:

- Keep the existing `Save Profile` mutation and form validation.
- Add a visible `Discover jobs` link/button to `/app/jobs` in the page header or action row, with an accessible name that describes the destination. It should be available before and after saving.
- Do not use the existing `Cancel` button as the only discovery path. If retaining Cancel, keep its semantics or rename it to `Back to Job Search` only if it still intentionally abandons unsaved changes; do not silently change form behavior.
- On narrow screens, stack the action buttons and make them full-width or naturally wrap without overflow.

### Step 7 - Verify, review, and regression-check (sequential)

No test runner is configured, so do not introduce a test framework as part of this scoped IA change. Verify with:

```text
npm run build
npm run lint
```

The implementor must also perform the manual keyboard/accessibility and responsive checks in the checklist below. If lint reports pre-existing unrelated errors, record the exact output and distinguish them from errors introduced by the change.

## EXACT INTERFACES AND ROUTE CONTRACTS

### Navigation data

`NavItem` must contain `label: string`, `href: string`, `icon: LucideIcon`, and optional `prominent?: boolean`. `NavGroup` must contain a stable group label and `items: NavItem[]`. Keep URLs as the literal strings listed above.

### Q&A data

Use the existing `QuestionAnswer` type and API contract from `src/services/api/jobs.ts`:

```ts
type QuestionAnswer = {
  id: string;
  question: string;
  answer: string;
  category?: "behavioral" | "technical" | "situational" | "general" | null;
  notes?: string | null;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
};
```

Do not add an API client, context provider, backend route, database column, migration, or IPC channel for Q&A.

### Contextual links

- Resume: `/app/match?resumeId=${encodeURIComponent(resume.id)}`.
- ATS report with resume ID: `/app/match?resumeId=${encodeURIComponent(report.resumeId)}`; without one: `/app/match`.
- Job detail: remain on `/app/jobs/:id`; evaluate, then invoke the existing `TailorPanel` flow.
- Career Profile: `/app/jobs`.

## CONSTRAINTS / DO NOT TOUCH

- Do not modify `src/index.css`, `src/App.css`, Tailwind theme configuration, design tokens, color values, typography imports, or animation theme styling.
- Do not change backend files, Prisma schema/migrations, API endpoints, authentication behavior, or existing query key contracts.
- Do not remove `/app/match`, `/app/upload`, `/app/build/:resumeId`, `/app/jobs/:id`, `/app/admin`, or any public route.
- Do not add Q&A to the public landing navigation; it is authenticated application functionality.
- Do not duplicate `AppLayout` inside the new Q&A page or move layout ownership into `App.tsx`.
- Do not turn cards into nested interactive elements. If a resume card is made link-based, keep buttons outside the link or use a single clear card link with separate sibling actions.
- Do not use `aria-hidden="true"` on meaningful text/icons that are the only accessible label. Decorative icons may be hidden when their adjacent text is available.
- Do not use hover-only focus visibility for actions needed by keyboard or touch users.
- Preserve loading/error/empty states on all modified pages.
- Import ordering must remain consistent with the current project style: external React/router/icon imports first, then `@/` components/hooks/services, then types. Avoid introducing imports from a page into layout (no circular dependency).

## RESPONSIVE ACCEPTANCE DETAILS

- 320px viewport: mobile header and menu work; sidebar labels are readable; no page-level horizontal scrollbar; Q&A form controls and resume/job/ATS action rows wrap.
- 768px viewport: mobile off-canvas behavior remains usable and focusable; grouped headings are visible when the sidebar is open.
- `lg` viewport: sidebar is static; collapse/expand works; all groups and labels remain in the specified order.
- Collapsed desktop sidebar: every item remains keyboard reachable and has an accessible label/tooltip; group headings are not announced as empty controls.
- Reduced-motion preference: no essential information depends on motion, and navigation remains immediately usable.

## ACCESSIBILITY ACCEPTANCE DETAILS

- There is one application navigation landmark named `Application navigation` and one main landmark with a stable target.
- Active route is communicated with `aria-current="page"`; descendant routes activate their parent item.
- Mobile open/close state is communicated with `aria-expanded`; focus enters and leaves the sidebar predictably; Escape closes it.
- All controls have accessible names; all form fields have labels or label associations; dialogs have titles and descriptions.
- Keyboard-only users can reach every group item, Job Search, Q&A actions, contextual CTAs, and logout without hover.
- Screen readers receive loading/error/status changes where applicable through existing status text or `aria-live="polite"`; errors use `role="alert"` when immediate attention is required.

## TESTING STRATEGY

Automated verification:

1. `npm run build` must pass with no TypeScript/Vite errors and must include the lazy Q&A route in the output.
2. `npm run lint` must pass, or the implementor must report exact pre-existing failures separately.
3. Search the source after implementation to confirm there are no stale authenticated history links: `src/pages/ATSHistory.tsx` must contain `/app/ats-scan`, not `/ats-scan`.
4. Search all `src/` references to confirm `/app/qa-bank` resolves to the protected Q&A route and no sidebar item points to an unregistered path.

Manual route checks:

- Authenticated direct loads of `/app/resumes`, `/app/build`, `/app/jobs`, `/app/qa-bank`, `/app/ats-scan`, `/app/ats-history`, `/app/profile`, and `/app/settings` render under `AppLayout`.
- `/app/jobs/:id` and `/app/build/:resumeId` highlight the correct parent sidebar item.
- Unauthenticated access to `/app/qa-bank` follows the existing `ProtectedRoute` redirect to `/auth` with the original location state.
- Resume CTA opens Match with the correct resume selected; invalid/missing query IDs do not select another user's or nonexistent resume.
- ATS CTA opens Match with a resume selected when available and with normal manual selection when not.
- Job Detail evaluation still leads to the existing TailorPanel and tailored builder result.
- Career Profile's Discover jobs control reaches `/app/jobs` without submitting or discarding the form unexpectedly.

## RISKS AND FAILURE MODES

- The requested phrase "ATS report -> Find matching jobs" is ambiguous for public/raw scans that have no builder `resumeId`. The chosen fallback is `/app/match` with manual resume selection; never fabricate an ID.
- Existing working-tree changes are unrelated and must not be reverted. The implementor should inspect its own diff before editing and stage only the frontend IA files if committing is later requested.
- `Match.tsx` currently owns selection state and loads the resume list asynchronously. Query initialization must happen after the list is available; otherwise a valid `resumeId` can be incorrectly discarded. Use an effect keyed to the loaded resumes or validate during render without overwriting user changes after initial initialization.
- `AppLayout.tsx` currently uses a motion `div` overlay and a fixed sidebar. A custom focus trap can be incomplete; prefer a small, well-tested focusable-element cycle or a Radix modal primitive if necessary, while preserving the current layout appearance.
- Resume cards and ATS history rows currently use click handlers on non-interactive `Card` elements. The new CTAs must not worsen this pattern; keyboard access to the existing card-open behavior should be addressed when touching those areas.
- `JobDetail.tsx` currently uses `window.history.back()` for Back. Do not change it as part of IA unless needed for focus/route correctness; if changed, use `navigate(-1)` and preserve fallback behavior.
- Build output already reports large chunks (notably the resume builder). This task must not broaden imports or disable lazy loading; Q&A must remain lazy-loaded.

## IMPLEMENTOR MUST VERIFY

- [ ] `src/App.tsx` has lazy `QABank`, protected `/app/qa-bank`, and a valid existing Admin import.
- [ ] `src/pages/QABank.tsx` exists, uses existing Q&A hooks/API types, and has accessible CRUD/loading/error/empty UI.
- [ ] `src/components/layout/AppLayout.tsx` renders WORK/JOBS/OPTIMISE/PROFILE/SYSTEM in exact order and conditionally renders Admin.
- [ ] Sidebar uses `/app/jobs` as the only primary jobs destination and labels it `Job Search` with existing-theme prominence.
- [ ] Sidebar active matching works for `/app/jobs/:id` and `/app/build/:resumeId`; active links expose `aria-current`.
- [ ] Mobile sidebar opens/closes with named controls, Escape, focus entry, focus restoration, and no background focus leakage.
- [ ] Desktop collapse keeps links keyboard reachable and labels icon-only controls.
- [ ] Skip link and labelled main landmark are present.
- [ ] `src/pages/Resumes.tsx` adds `Find matching jobs` with encoded `resumeId` and no click propagation regression.
- [ ] `src/pages/Match.tsx` consumes and validates `resumeId` query context without bypassing loaded user resumes.
- [ ] `src/pages/ATSScan.tsx` and `src/pages/ATSHistory.tsx` add matching CTAs with the no-resume fallback.
- [ ] `src/pages/ATSHistory.tsx` uses `/app/ats-scan` for New Scan and empty state.
- [ ] `src/pages/JobDetail.tsx` makes the existing evaluate/tailor sequence explicitly discoverable and responsive.
- [ ] `src/pages/Profile.tsx` has a visible `Discover jobs` action to `/app/jobs` independent of Cancel.
- [ ] No theme, color, typography, backend, schema, or API contract files were changed.
- [ ] `npm run build` passes and `npm run lint` passes or its exact baseline failures are documented.
- [ ] 320px, 768px, and desktop/collapsed-sidebar keyboard checks pass with no horizontal overflow.
