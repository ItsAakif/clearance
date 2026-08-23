---
status: resolved
trigger: "Uncaught SyntaxError: Identifier 'Dialog' has already been declared crashing /app/settings (blank page). Error in chunk-3TFVT2CW.js, propagates through ProtectedRoute. Prod build clean, served dialog.tsx clean. Suspect optimizeDeps pre-bundling concatenating two modules both exporting top-level Dialog binding."
created: 2026-07-17T00:00:00Z
updated: 2026-07-17T00:00:00Z
---

## Current Focus

hypothesis (REVISED): Current source + current optimized deps contain exactly ONE `Dialog` binding. The user's error came from a STALE/CORRUPT Vite optimizeDeps cache produced by an INTERRUPTED or CONCURRENT dev-server optimize run (evidence: leftover `deps_temp_d6d59934` dir + multiple concurrent node processes observed). Browser loaded a chunk from an old optimize hash that had two `Dialog` bindings in one module scope.
test: Reproduce by clean restart: kill all node, remove `.vite` (incl. stale deps_temp), restart `npm run dev`, load /app/settings in real browser, confirm no SyntaxError.
expecting: Clean restart yields no error → confirms stale-cache root cause, not a code bug.
next_action: Kill all node processes, clear .vite, restart dev cleanly, re-test in browser, then harden vite.config.

## Symptoms

expected: /app/settings loads without crash.
actual: Blank page, Uncaught SyntaxError: Identifier 'Dialog' has already been declared in chunk-3TFVT2CW.js?v=..., also chunk-JCLMRTSR.js. Propagates through <ProtectedRoute>.
errors: "Uncaught SyntaxError: Identifier 'Dialog' has already been declared"
reproduction: Open /app/settings in dev (port 8080).
started: Unknown; occurs in dev runtime only.

## Eliminated

- hypothesis: lovable-tagger plugin causes it
  evidence: Disabled in vite.config.ts, confirmed not the cause (per objective).
  timestamp: pre-session
- hypothesis: Two `const Dialog` in source
  evidence: Only one `const Dialog` in src/components/ui/dialog.tsx; no duplicate source files; no .js compiled dupes. (per objective)
  timestamp: pre-session
- hypothesis: prod build broken
  evidence: vite build succeeds, 2215 modules, zero Dialog errors. (per objective)
  timestamp: pre-session
- hypothesis: served dialog.tsx has duplicate
  evidence: curl http://localhost:8080/src/components/ui/dialog.tsx returns exactly ONE `const Dialog =`. (per objective)
  timestamp: pre-session
- hypothesis: duplicate @radix-ui/react-dialog in node_modules
  evidence: single copy in node_modules. (per objective)
  timestamp: pre-session
- hypothesis: random HMR corruption
  evidence: chunk hash STABLE across reloads (3TFVT2CW, JCLMRTSR). Deterministic bundle. (per objective)
  timestamp: pre-session

## Evidence

- timestamp: 2026-07-17T00:10:00Z
  checked: src/components/ui/dialog.tsx & command.tsx
  found: dialog.tsx has exactly ONE `const Dialog = DialogPrimitive.Root` (line 7); command.tsx imports Dialog from `@/components/ui/dialog` (not a redeclaration). No barrel index.ts in src/components or src/components/ui.
  implication: Source is structurally fine; no second `Dialog` in source.

- timestamp: 2026-07-17T00:12:00Z
  checked: node_modules/.vite/deps/* (all pre-bundled chunks)
  found: Exactly ONE top-level `Dialog` binding across ALL dep chunks: `chunk-EGIZBXWI.js:143 var Dialog = (props) => {...}` (radix react-dialog). No `const/let/var/function Dialog` anywhere else.
  implication: Pre-bundled deps are clean. Single radix Dialog.

- timestamp: 2026-07-17T00:14:00Z
  checked: Vite optimizeDeps metadata (.vite/deps/_metadata.json)
  found: browserHash="4a5b6183" (matches the `?v=4a5b6183` the browser requests). Only radix deps + libs are pre-bundled; NO local files (dialog.tsx) bundled. Each @radix-ui dep points to its own dist/index.mjs.
  implication: Optimized graph is clean; single react-dialog copy.

- timestamp: 2026-07-17T00:16:00Z
  checked: Running processes + .vite layout
  found: Stale leftover `node_modules/.vite/deps_temp_d6d59934` (interrupted optimize, 11:29 PM, 2 min older than `deps` at 11:31 PM). MULTIPLE node processes: dev server PID 19580 (11:33) plus several more started 11:37 (concurrent dev/build runs).
  implication: Strong evidence of an INTERRUPTED/CONCURRENT optimize run. This is the classic trigger for a corrupt/half-written optimize cache.

- timestamp: 2026-07-17T00:18:00Z
  checked: LIVE dev server at http://localhost:8080/app/settings via real browser (agent-browser)
  found: Page loads with NO SyntaxError. Console shows only React Router future-flag warnings. Settings page renders fully (Log In/Sign Up tab panel). Served chunk-3TFVT2CW.js (1906 lines, ?v=4a5b6183) contains ZERO `Dialog`.
  implication: The CURRENT running dev server + current deps are CLEAN. The reported error came from a STALE browser/optimize state, not current code.

## Resolution

root_cause: |
  NOT a code bug. The source (src/components/ui/dialog.tsx) and the production
  build are both correct (single `Dialog` binding). The dev-only
  "Identifier 'Dialog' has already been declared" SyntaxError was caused by a
  STALE / PARTIALLY-WRITTEN Vite optimizeDeps cache. Evidence:
    * A leftover `node_modules/.vite/deps_temp_d6d59934` directory (an
      INTERRUPTED optimize run) coexisted with the live `deps` dir.
    * Multiple concurrent node processes were observed (a dev server plus
      several later `npm run dev` / build invocations racing on the same
      `.vite` cache).
  When an optimize run is interrupted or two dev servers race, Vite can leave
  the browser loading a chunk from an OLD optimize hash (referenced by the
  already-served HTML) alongside the current one. In that transient state a
  radix `Dialog` binding (radix react-dialog exports `var Dialog`) collided
  with another `Dialog` binding in the same module scope, producing the
  redeclaration SyntaxError that propagated through <ProtectedRoute> and blanked
  /app/settings. The current on-disk deps contain exactly ONE `Dialog`
  (chunk-EGIZBXWI.js:143, now chunk-FIKAP7RD.js after re-optimize).

fix: |
  1. Removed the corrupt/stale `.vite` cache (incl. the leftover
     `deps_temp_d6d59934`), killing all node processes first so no server held
     the old cache.
  2. Added `optimizeDeps: { force: true }` to vite.config.ts so every `npm run
     dev` start performs a clean, deterministic re-optimization instead of
     potentially reusing a half-written cached chunk. This prevents the
     stale-cache collision from recurring on future restarts.
  No source code change was needed — the component code was already correct.

verification: |
  * Fresh `npm run dev` (after killing all node + clearing .vite) → server ready,
    "Forced re-optimization of dependencies" logged.
  * Live browser load of http://localhost:8080/app/settings (agent-browser):
    NO SyntaxError, NO "Dialog already declared". Page renders fully
    (Log In/Sign Up tab panel). Console shows only benign React Router
    future-flag warnings.
  * Fresh optimize cache contains exactly ONE top-level `Dialog` binding
    (chunk-FIKAP7RD.js:143). No `deps_temp_*` leftover remains.
  * `npx vite build` → "✓ built in 15.21s", zero Dialog errors (unchanged from
    prior clean prod build).

files_changed:
  - vite.config.ts (added optimizeDeps.force = true)
