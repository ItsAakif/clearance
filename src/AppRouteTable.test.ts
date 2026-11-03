// Route-table contract for `src/App.tsx` (T1110 cutover).
//
// WHAT CHANGED FROM THE T1070 VERSION OF THIS FILE, AND WHY IT IS A REWRITE RATHER THAN AN
// EDIT. The old file had three parts, all built on the same premise: that there are two builds,
// and that the route table, the sidebar and the link sweep had to agree in BOTH of them.
//
//   T1070's premise: `v2ResumeStudio` off = the V1 app. Part 2 of that file asserted the
//   flag-off sidebar against a frozen copy of HEAD's nine entries, and part 2's sweep asserted
//   that every flag-off-reachable `/app/...` link resolved in the FLAG-OFF table - which is why
//   it had to enumerate the V2-only modules and prove that nothing flag-off imported them.
//
//   T1110's reality: the legacy builder is DELETED. There is no V1 app left to fall back to,
//   so there is nothing for a flag to select between. The owner's instruction is explicit -
//   "the old Build screen must COMPLETELY disappear" - and it supersedes the task contract's
//   "flag OFF => byte-identical legacy behaviour" acceptance item, because there is no legacy
//   behaviour left to be byte-identical to.
//
// So this file now asserts ONE build:
//
//   1. EVERY RETIRED PATH HAS A REAL REDIRECT. `/app/build`, `/app/build/:resumeId`,
//      `/get-started/ai` and `/get-started/ai-build` are all declared in `src/App.tsx` with a
//      `<Navigate ... replace>`, and the parametrised one resolves through `studioRedirectFor`.
//      A `replace` is not a style preference: with a push, the back button returns to the
//      retired path, which redirects again, and the user cannot leave.
//   2. THE LINK SWEEP, over every reachable source. Every internal link literal - `/app/...`
//      AND `/get-started/...`, which the old sweep ignored because it was flag-off only - must
//      resolve in the real table. A link to a retired path is a dead end, which is the whole
//      failure mode this cutover could have introduced.
//   3. NAV. There is no "Build" entry, the five V2 entries are present, and every href
//      resolves.
//
// WHY IT IS STILL A SOURCE-LEVEL CONTRACT AND NOT A RENDER TEST. ADR-031 decision 3 (and
// `vitest.config.ts`: `environment: 'node'`, `include: ['src/**/*.test.ts']`) forbids jsdom,
// React Testing Library and `.test.tsx` in this repo, and adding a dependency is out of scope.
// `matchRoutes` from `react-router-dom` is DOM-free, so the REAL router's matcher runs here
// against a route table extracted from the REAL `src/App.tsx`: the matching is genuine, and
// what is extracted is a declaration of intent rather than a second hand-kept copy.
//
// THE PARSER, HONESTLY. It reads the `<Route path=... element=.../>` declarations and records,
// per route, the page it renders or the redirect it performs. It understands every shape
// `src/App.tsx` uses: `element={<Page />}`, the multi-line
// `element={<ProtectedRoute><Page /></ProtectedRoute>}`, `element={<Navigate to="..." replace />}`,
// `element={<LegacyBuilderRedirect />}` and the flag-aware
// `element={flags.v2ResumeStudio ? <A /> : <B />}`. A shape it does not understand leaves both
// the page and the redirect `null`, which the resolution assertions report as a failure - the
// direction that matters - rather than passing silently.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchRoutes } from "react-router-dom";
import { appNavItems, appNavItemsFor, activeNavItemFor } from "@/components/layout/navigation";
import {
  LEGACY_ROUTE_REDIRECTS,
  LEGACY_PARAM_REDIRECTS,
  ALL_RETIRED_PATHS,
  studioRedirectFor,
  tailorRedirectFor,
  prepRedirectFor,
} from "@/routes/legacyRedirects";

const SRC = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Reading the real route table out of src/App.tsx
// ---------------------------------------------------------------------------

const APP_SRC = readFileSync(path.join(SRC, "App.tsx"), "utf8");

/** `const Match = lazy(() => import("./pages/Match"));` -> identifier -> module name. */
const LAZY_PAGES: Record<string, string> = Object.fromEntries(
  [...APP_SRC.matchAll(/const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\("([^"]+)"\)\s*,?\s*\)/g)].map(
    (m) => [m[1], m[2].split("/").pop() as string],
  ),
);

interface ParsedRoute {
  /** `null` for the pathless `<Route element={<ProtectedRoute><AppLayout/></ProtectedRoute>}>`. */
  path: string | null;
  /** Page identifier rendered by the flag-off element (`null` for redirects and unguarded pages). */
  page: string | null;
  /** Page identifier rendered by the flag-ON branch of a flag-aware element. */
  flagOnPage: string | null;
  /** Target of a `<Navigate to="...">`, if that is the element. */
  redirectTo: string | null;
  /** True for `element={<LegacyBuilderRedirect />}`, which redirects via `studioRedirectFor`. */
  paramRedirect: boolean;
  /** True when the declaration says `replace`. Every retired path must. */
  replace: boolean;
  /** `raw` is the declaration text, used for the "declared inside a conditional" check. */
  raw: string;
}

function parseRoutes(source: string): ParsedRoute[] {
  const starts: number[] = [];
  for (let i = source.indexOf("<Route"); i !== -1; i = source.indexOf("<Route", i + 1)) starts.push(i);
  return starts.map((at, i) => {
    const text = source.slice(at, i + 1 < starts.length ? starts[i + 1] : source.length);
    const declaredPath = text.match(/path="([^"]*)"/);
    const ternary = text.match(/element=\{flags\.v2ResumeStudio \? <(\w+) \/> : <(\w+) \/>\}/);
    const plain = text.match(/element=\{<(\w+) \/>\}/);
    const guarded = text.match(/element=\{\s*<ProtectedRoute>[\s\S]*?<(\w+) \/>\s*<\/ProtectedRoute>\s*\}/);
    const redirect = text.match(/element=\{<Navigate to="([^"]+)"(\s+replace)?\s*\/>\}/);
    const isParamRedirect = /element=\{<Legacy\w+Redirect \/>\}/.test(text);
    return {
      path: declaredPath ? declaredPath[1] : null,
      // `LegacyBuilderRedirect` matches the plain-element shape too, and it is NOT a page: it
      // is a redirect. Classifying it as a page would make `resolvedPage` return a module name
      // for a path that renders nothing, which is the one misreading this table must not have.
      page: isParamRedirect ? null : (plain?.[1] ?? guarded?.[1] ?? null),
      flagOnPage: ternary ? ternary[1] : null,
      redirectTo: redirect ? redirect[1] : null,
      paramRedirect: isParamRedirect,
      replace: redirect?.[2] !== undefined,
      raw: text,
    };
  });
}

const ROUTES = parseRoutes(APP_SRC);

/** The route table as react-router would see it. The pathless layout route takes no part in matching. */
function table() {
  return ROUTES.filter((r) => r.path !== null).map((r) => ({
    path: r.path as string,
    // A page identifier stands in for the rendered element; a redirect is identified as one,
    // because "does this path still work" and "what does it show" are different questions.
    element:
      (r.page ?? r.flagOnPage ?? null) ??
      (r.paramRedirect ? `ParamRedirect(${r.path})` : `Navigate(${r.redirectTo ?? "?"})`),
  }));
}

/**
 * The leaf route react-router resolves `target` to, or `null` when the only thing that matched
 * is the catch-all - i.e. the path is NOT registered, which is the state the old sweep existed
 * to keep impossible and which the redirects must keep impossible.
 */
function resolvedRoute(target: string) {
  const matches = matchRoutes(table(), target);
  if (!matches) return null;
  const leaf = matches[matches.length - 1].route;
  return leaf.path === "*" ? null : leaf;
}

/** The identifier of the page react-router would render for `target`, or `null`. */
function resolvedPage(target: string): string | null {
  const leaf = resolvedRoute(target);
  if (!leaf) return null;
  const element = leaf.element as unknown as string;
  if (element.startsWith("Navigate(") || element.startsWith("ParamRedirect(")) return null;
  return LAZY_PAGES[element] ?? null;
}

const routeFor = (path: string): ParsedRoute | undefined =>
  ROUTES.filter((r) => r.path === path)[0];

// ---------------------------------------------------------------------------
// Part 1 - every retired path has a real redirect
// ---------------------------------------------------------------------------

describe("every retired path resolves to its V2 successor", () => {
  it("the retired-path inventory is exactly the paths the merges removed", () => {
    // A COPY of the inventory, deliberately. `routes/legacyRedirects.ts` is the module the
    // component reads, so asserting it against itself would prove nothing; this pins the set
    // so adding a path there without declaring a route for it fails here.
    expect([...ALL_RETIRED_PATHS].sort()).toEqual([
      "/app/ats-history",
      "/app/ats-scan",
      "/app/build",
      "/app/build/:resumeId",
      "/app/career",
      "/app/career-interview",
      "/app/interview-prep",
      "/app/interview-prep/:resumeId",
      "/app/project-discovery",
      "/app/qa",
      "/app/qa-bank",
      "/app/tailor",
      "/app/tailor/:resumeId",
      "/get-started/ai",
      "/get-started/ai-build",
    ]);
  });

  for (const { from, to, because } of LEGACY_ROUTE_REDIRECTS) {
    it(`\`${from}\` is declared as a replace-redirect to \`${to}\` (${because})`, () => {
      const route = routeFor(from);
      expect(route).toBeDefined();
      expect(route!.redirectTo).toBe(to);
      // `replace`, because a push leaves the back button pointing at the retired path, which
      // redirects again: an unreachable history entry the user has to click twice to escape.
      expect(route!.replace).toBe(true);
      // It RESOLVES - declared is not the same as matched.
      expect(resolvedRoute(from)).not.toBeNull();
      // ...and it resolves to the redirect rather than to a page.
      expect(resolvedPage(from)).toBeNull();
      // The target is itself a live route. A redirect to a 404 is the failure this guards.
      expect(resolvedRoute(to)).not.toBeNull();
    });
  }

  it("every parametrised retired path is declared with the redirect component, not a page", () => {
    for (const { from } of LEGACY_PARAM_REDIRECTS) {
      const route = routeFor(from);
      expect([from, route?.paramRedirect]).toEqual([from, true]);
      // The legacy page is GONE, not merely re-pointed: no route renders it.
      expect([from, route?.page]).toEqual([from, null]);
      expect([from, resolvedPage(from)]).toEqual([from, null]);
    }
  });

  it("studioRedirectFor maps the param onto the Studio and the bare case onto the chooser", () => {
    expect(studioRedirectFor({ resumeId: "abc123" })).toBe("/app/studio/abc123");
    // The bare case is the one that would otherwise produce `/app/studio/undefined` - a 404,
    // which is exactly the dead end this redirect exists to remove.
    expect(studioRedirectFor({})).toBe("/app/studio");
    expect(studioRedirectFor({ resumeId: "" })).toBe("/app/studio");
    // An id with a slash in it is not an id; the value is not sanitised here, and must not be -
    // inventing a sanitiser would be a second, disagreeing authority on the id shape.
    expect(studioRedirectFor({ resumeId: "a b" })).toBe("/app/studio/a b");
  });

  it("the merge redirects keep the resume id", () => {
    expect(tailorRedirectFor({ resumeId: "abc123" })).toBe("/app/match/tailor/abc123");
    expect(tailorRedirectFor({})).toBe("/app/match/tailor");
    expect(prepRedirectFor({ resumeId: "abc123" })).toBe("/app/interview/prep/abc123");
    expect(prepRedirectFor({})).toBe("/app/interview/prep");
  });

  it("a concrete deep link matches the Studio route with the id substituted", () => {
    // The end-to-end statement the parametrised redirect exists to make: `/app/build/xyz` is
    // not a dead end, and it lands on the Studio FOR THAT RESUME, not on the chooser.
    const target = studioRedirectFor({ resumeId: "xyz" });
    expect(target).toBe("/app/studio/xyz");
    expect(resolvedPage(target)).toBe("Studio");
    // And the chooser is where the id-less redirect lands.
    expect(resolvedPage(studioRedirectFor({}))).toBe("Studio");
  });

  it("the merged deep links keep working with their resume ids", () => {
    expect(resolvedPage(tailorRedirectFor({ resumeId: "xyz" }))).toBe("Tailor");
    expect(resolvedPage(prepRedirectFor({ resumeId: "xyz" }))).toBe("InterviewPrep");
    expect(resolvedRoute(tailorRedirectFor({}))).not.toBeNull();
    expect(resolvedRoute(prepRedirectFor({}))).not.toBeNull();
  });

  it("neither retired path resolves to a DELETED page - the lazy imports are gone from the table", () => {
    // `Build` and `AIBuild` were deleted. If either were still declared, it would still resolve
    // to a chunk that cannot be fetched - the worst outcome, because it fails only at runtime.
    expect(LAZY_PAGES.Build).toBeUndefined();
    expect(LAZY_PAGES.AIBuild).toBeUndefined();
    for (const from of ALL_RETIRED_PATHS) {
      const page = resolvedPage(from);
      expect([from, page]).toEqual([from, null]);
    }
  });

  it("the canonical pages the redirects land on are all registered", () => {
    for (const target of [
      "/app/resumes",
      "/app/studio",
      "/app/studio/xyz",
      "/app/profile",
      "/app/profile/preferences",
      "/app/match",
      "/app/match/tailor",
      "/app/match/tailor/xyz",
      "/app/match/projects",
      "/app/interview",
      "/app/interview/prep",
      "/app/interview/prep/xyz",
      "/app/interview/questions",
    ]) {
      expect([target, resolvedRoute(target) !== null]).toEqual([target, true]);
    }
    expect(resolvedPage("/app/studio")).toBe("Studio");
    expect(resolvedPage("/app/profile")).toBe("CareerProfile");
    expect(resolvedPage("/app/profile/preferences")).toBe("Profile");
    expect(resolvedPage("/app/match")).toBe("Match");
    expect(resolvedPage("/app/match/tailor")).toBe("Tailor");
    expect(resolvedPage("/app/match/projects")).toBe("ProjectDiscoveryPage");
    expect(resolvedPage("/app/interview")).toBe("CareerInterview");
    expect(resolvedPage("/app/interview/prep")).toBe("InterviewPrep");
    expect(resolvedPage("/app/interview/questions")).toBe("QABank");
  });

  it("T1101: `/app/match` is the V2 report UNCONDITIONALLY, and the V1 page is gone", () => {
    // The flag-aware element `flags.v2ResumeStudio ? <Match /> : <MatchLegacy />` is gone, and with
    // it the LAST read of that flag in the app. `MatchLegacy` existed to render `matchScore`, so it
    // is deleted, and `LAZY_PAGES.MatchLegacy` being undefined is what makes the deletion visible
    // here rather than only in a file listing.
    const route = routeFor("/app/match");
    expect(route).toBeDefined();
    expect(route!.page).toBe("Match");
    expect(route!.flagOnPage).toBeNull();
    // The flags import itself is gone: nothing in the route table reads a flag any more.
    expect(APP_SRC).not.toMatch(/import \{ flags \} from "@\/lib\/flags"/);
    expect(LAZY_PAGES.MatchLegacy).toBeUndefined();
    // ...and no route in the whole table is flag-aware any more. `parseRoutes` would leave
    // `flagOnPage` null for every path if the `{flags.… ? A : B}` shape were gone.
    expect(ROUTES.filter((row) => row.flagOnPage !== null).map((row) => row.path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 2 - the link sweep
// ---------------------------------------------------------------------------

/**
 * Strip line comments, leaving `https://` alone: a `//` is a comment here only at the start of a
 * line (after whitespace) or on a block-comment continuation line, and a URL's `//` follows a
 * scheme character. Comments are stripped so a prose mention of a path cannot masquerade as a
 * link; a `/* ... *\/` comment that starts and ends on one line is NOT stripped, so the worst case
 * is a link literal the sweep cannot see - never a false pass.
 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.search(/^\s*(\/\/|\*)/) === 0 ? line.slice(0, line.search(/\S/)) : line))
    .join("\n");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * EVERY source in `src/` that is not a test. There is no longer a flag-off-reachable subset to
 * carve out: there is one build, so every module is in the sweep's scope. The two exclusions
 * are the test files themselves - which is what makes this a test rather than a command - and
 * nothing else.
 */
const ALL_SOURCES = walk(SRC)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => path.relative(SRC, f).replace(/\\/g, "/"));

/** Normalise a link literal to a concrete path: drop query/hash, fill placeholders. */
function normalizeTarget(raw: string): string {
  const withoutQuery = raw.split(/[?#]/)[0].trim();
  const filled = withoutQuery
    .replace(/\$\{[^}]*\}/g, "x")
    .replace(/:[A-Za-z][A-Za-z0-9]*/g, "x");
  return filled.length > 1 && filled.endsWith("/") ? filled.slice(0, -1) : filled;
}

/**
 * Every internal link literal in a source file, normalised and de-duplicated. BOTH `/app/` and
 * `/get-started/` are swept: the old sweep was `/app/`-only because it modelled a flag-off
 * build, and `/get-started/ai*` are exactly the paths this cutover retired.
 */
function linkLiterals(source: string): string[] {
  const matches = stripLineComments(source).matchAll(/["'`]\/(?:app|get-started)\/[A-Za-z0-9_\-/${}.:]*/g);
  return [...new Set([...matches].map((m) => normalizeTarget(m[0].slice(1))))].sort();
}

describe("link sweep: no link in the app targets a dead path", () => {
  it("covers every non-test source (a walk that found nothing would pass vacuously)", () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(60);
  });

  it("every /app and /get-started link literal resolves in the real route table", () => {
    const broken: string[] = [];
    const targets = new Set<string>();
    for (const file of ALL_SOURCES) {
      for (const target of linkLiterals(readFileSync(path.join(SRC, file), "utf8"))) {
        targets.add(target);
        if (resolvedRoute(target) === null) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
    expect(targets.size).toBeGreaterThanOrEqual(15);
  });

  it("no source links DIRECTLY at a retired path outside the route-table and nav files", () => {
    // The redirect declarations name the retired paths, and so does `legacyRedirects.ts`.
    // `navigation.ts` also names them in `match` lists, deliberately: the sidebar must stay
    // selected on an old URL for the one render before the redirect lands. Every OTHER file
    // must have been REPOINTED, not left pointing at a path that only resolves by accident.
    const ALLOWED = ["App.tsx", "routes/legacyRedirects.ts", "components/layout/navigation.ts"];
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      if (ALLOWED.includes(file)) continue;
      const code = stripLineComments(readFileSync(path.join(SRC, file), "utf8"));
      for (const [, raw] of code.matchAll(
        /["'`](\/(?:app\/build|app\/career|app\/interview-prep|app\/qa-bank|app\/qa|app\/tailor|app\/project-discovery|get-started\/ai)[\w/${}?.:-]*)["'`]/g,
      )) {
        offenders.push(`${file} -> ${raw}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the surfaces that USED to link at the builder now point at the Studio", () => {
    // The frozen inventory of repointed call sites. Each is a REAL navigation the user can
    // take, so each is a place the cutover could have silently left dead-ending.
    // T1110's backend/score half DELETED two of the five callers (`ATSHistory.tsx` and
    // `MatchLegacy.tsx` - both existed only to present a number), so the inventory shrank.
    // The landing footer is deliberately absent: the marketing page is hosted
    // separately and its app destinations now go through `appHref`, so it no
    // longer contains a react-router link to the Studio (or any route).
    const REPOINTED: Record<string, number> = {
      "pages/Resumes.tsx": 5,
      "pages/Upload.tsx": 2,
    };
    for (const [file, expected] of Object.entries(REPOINTED)) {
      const code = stripLineComments(readFileSync(path.join(SRC, file), "utf8"));
      const raw = [...code.matchAll(/["'`]\/app\/studio[^"'`]*/g)].map((m) => normalizeTarget(m[0].slice(1)));
      // One assertion per FILE, counting LINK EXPRESSIONS: this is the inventory of repointed
      // call sites, so a surface that quietly regains a `/app/build` link fails it.
      expect([file, raw.length]).toEqual([file, expected]);
      // Every one of them is the chooser or the parametrised Studio - not merely "a string that
      // happens to start the same". `normalizeTarget` collapses `${...}` to `x`, so the DE-DUPED
      // set is asserted here rather than the count: five expressions may legitimately be one
      // literal repeated.
      const swept = linkLiterals(code).filter(
        (target) => target === "/app/studio" || target.startsWith("/app/studio/"),
      );
      expect([file, [...new Set(swept)].sort()]).toEqual([file, [...new Set(raw)].sort()]);
    }
    // `GetStarted.tsx` is the public path card: one to the Studio, one to the career record.
    const getStarted = stripLineComments(readFileSync(path.join(SRC, "pages", "GetStarted.tsx"), "utf8"));
    expect([...getStarted.matchAll(/["'`]\/app\/studio["'`]/g)].length).toBe(1);
    expect([...getStarted.matchAll(/["'`]\/app\/profile["'`]/g)].length).toBe(1);
  });

  it("still has a catch-all, so 'unregistered' means NotFound rather than a blank page", () => {
    expect(ROUTES.filter((r) => r.path === "*")).toHaveLength(1);
    // An unknown path resolves to nothing real, which is what a retired path would be reduced
    // to had its redirect been missing - so this must stay true.
    expect(resolvedRoute("/app/nothing-here")).toBeNull();
    for (const from of ALL_RETIRED_PATHS) {
      expect([from, resolvedRoute(from) !== null]).toEqual([from, true]);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 3 - the nav has no Build entry, has the V2 entries, and every href resolves
// ---------------------------------------------------------------------------

describe("navigation after the merge", () => {
  it("there is NO Build entry, and nothing points at /app/build", () => {
    const items = appNavItemsFor();
    expect(items.some((item) => item.href === "/app/build")).toBe(false);
    expect(items.some((item) => item.label === "Build")).toBe(false);
    expect(appNavItems.some((item) => item.href === "/app/build")).toBe(false);
  });

  it("renders exactly the eight merged entries in the owner's order", () => {
    expect(appNavItemsFor().map((item) => item.href)).toEqual([
      "/app/resumes",
      "/app/profile",
      "/app/jobs",
      "/app/match",
      "/app/interview",
      "/app/applications",
      "/app/insights",
      "/app/settings",
    ]);
    expect(appNavItemsFor().map((item) => item.label)).toEqual([
      "Resumes",
      "Profile",
      "Jobs",
      "Match",
      "Interview",
      "Applications",
      "Insights",
      "Settings",
    ]);
  });

  it("points every entry at a live route", () => {
    const dead = appNavItemsFor()
      .map((item) => item.href)
      .filter((href) => resolvedRoute(href) === null);
    expect(dead).toEqual([]);
  });

  it("renders exactly the one declared baseline, and is not gated on a flag", () => {
    const items = appNavItemsFor();
    expect(items).toEqual(appNavItems);
    // No `flags` import anywhere: there is no state left for it to select.
    expect(APP_SRC.includes('import { flags } from "@/lib/flags"')).toBe(false);
    const nav = readFileSync(path.join(SRC, "components", "layout", "navigation.ts"), "utf8");
    expect(nav.includes("@/lib/flags")).toBe(false);
  });

  it("keeps each section active on its child and retired routes", () => {
    const items = appNavItemsFor();
    const active = (pathname: string) => activeNavItemFor(items, pathname)?.href ?? null;
    expect(active("/app/resumes")).toBe("/app/resumes");
    expect(active("/app/studio")).toBe("/app/resumes");
    expect(active("/app/studio/abc")).toBe("/app/resumes");
    expect(active("/app/profile")).toBe("/app/profile");
    expect(active("/app/profile/preferences")).toBe("/app/profile");
    expect(active("/app/career")).toBe("/app/profile");
    expect(active("/app/match")).toBe("/app/match");
    expect(active("/app/match/tailor/abc")).toBe("/app/match");
    expect(active("/app/project-discovery")).toBe("/app/match");
    expect(active("/app/interview")).toBe("/app/interview");
    expect(active("/app/interview/prep/abc")).toBe("/app/interview");
    expect(active("/app/qa-bank")).toBe("/app/interview");
    // The detail page keeps Applications active, and nothing else lights up for it.
    expect(active("/app/applications/abc")).toBe("/app/applications");
    expect(active("/app/jobs/abc")).toBe("/app/jobs");
  });

  it("T1101: the nav has no ATS Scan or ATS History entry", () => {
    // Both surfaces existed to present a number, so both are retired. Their ROUTES stay declared as
    // replace-redirects to `/app/match`, so an old bookmark still lands somewhere honest - but a
    // sidebar entry that silently lands elsewhere is a lie about what the app is.
    const items = appNavItemsFor();
    for (const retired of ["/app/ats-scan", "/app/ats-history"]) {
      expect([retired, items.some((item) => item.href === retired)]).toEqual([retired, false]);
      expect([retired, resolvedRoute(retired) !== null]).toEqual([retired, true]);
      expect([retired, resolvedPage(retired)]).toEqual([retired, null]);
    }
    for (const gone of ["ATS Scan", "ATS History"]) {
      expect([gone, items.some((item) => item.label === gone)]).toEqual([gone, false]);
    }
    expect(appNavItems.some((item) => item.href === "/app/ats-scan")).toBe(false);
    expect(appNavItems.some((item) => item.href === "/app/ats-history")).toBe(false);
  });

  it("Profile is one entry, with the job-preferences page as its second tab", () => {
    const items = appNavItemsFor();
    const profile = items.filter((item) => item.href === "/app/profile");
    expect(profile).toHaveLength(1);
    expect(profile[0].label).toBe("Profile");
    expect(profile[0].match).toEqual(["/app/profile", "/app/career"]);
    expect(resolvedPage("/app/profile/preferences")).toBe("Profile");
    expect(resolvedRoute("/app/career")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 4 - the legacy tree is GONE (the reachability proof as a gate)
// ---------------------------------------------------------------------------

/**
 * The paths FREEZE.md bucket A schedules for removal at P10, as the FRONTEND saw them at the
 * start of T1110. This is a COPY rather than a read of the manifest, for the same reason the
 * inventory above is: a list that is generated from the thing it checks proves nothing.
 *
 * Every one of these was proved unreachable-before-deletion by the reachability walker
 * (see `.planning/progress/T1110-cutover-frontend.md`); `npx tsc --noEmit`, `npm run lint`,
 * `npm run build` and `npm test` are what prove no live module referenced them afterwards.
 */
const RETIRED_PATHS: readonly string[] = [
  "features/resume-builder",
  "features/template-selector",
  "components/ats",
  "pages/Build.tsx",
  "pages/AIBuild.tsx",
  "hooks/useResumeData.ts",
  "hooks/useDynamicResumeData.ts",
  "hooks/useTemplateSettings.ts",
  "lib/templateMapping.ts",
  "types/template.ts",
  // T1110 backend/score half + T1101: the score surfaces and their clients.
  "pages/ATSScan.tsx",
  "pages/ATSHistory.tsx",
  "pages/MatchLegacy.tsx",
  "features/ats-report",
  "features/job-match",
  "features/question-answers/GenerateAnswerDialog.tsx",
  "features/jobs/TailorPanel.tsx",
  "hooks/useATS.ts",
  "services/api/ats.ts",
  "services/api/ai.ts",
  "types/ats.ts",
];

describe("the legacy builder tree is deleted", () => {
  for (const retired of RETIRED_PATHS) {
    it(`src/${retired} does not exist`, () => {
      expect(existsSync(path.join(SRC, retired))).toBe(false);
    });
  }

  it("no module imports a deleted path", () => {
    // The reachability proof, as an ongoing gate. A `from "@/features/resume-builder"` in any
    // file would be a module the bundler cannot resolve - `tsc` and `vite build` also fail on
    // it, but this names the culprit instead of reporting a bare resolution error.
    const SPECIFIERS = [
      "@/features/resume-builder",
      "@/features/template-selector",
      "@/components/ats",
      "@/hooks/useResumeData",
      "@/hooks/useDynamicResumeData",
      "@/hooks/useTemplateSettings",
      "@/lib/templateMapping",
      "@/types/template",
      "@/features/ats-report",
      "@/features/job-match",
      "@/features/question-answers/GenerateAnswerDialog",
      "@/features/jobs/TailorPanel",
      "@/hooks/useATS",
      "@/services/api/ats",
      "@/services/api/ai",
      "@/types/ats",
    ];
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const code = readFileSync(path.join(SRC, file), "utf8");
      for (const spec of SPECIFIERS) {
        if (code.includes(`"${spec}`) || code.includes(`'${spec}`) || code.includes(`"${spec}/`)) {
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the live trees the cutover was told NOT to delete are all still present", () => {
    // A deletion is judged by what survives as much as by what goes. These are the paths the
    // task named as off-limits; if one is missing, the cutover over-reached.
    // T1110's frontend half kept `features/job-match`, `pages/MatchLegacy.tsx` and
    // `services/api/ai.ts` here BECAUSE `/app/match` still had a flag-aware element pointing at
    // them. T1101 deleted that element, so those three are legitimately gone now - and their
    // absence is asserted in `RETIRED_PATHS` above rather than quietly dropped.
    for (const kept of [
      "pages/Profile.tsx",
      "components/ui/button.tsx",
      "lib/exportHtml.ts",
      "hooks/useResumeApi.ts",
      "services/api/templates.ts",
      "types/resume.ts",
      // The V2 surfaces the retirements point at. If one of these went, "no score" would have
      // replaced a number with nothing.
      "pages/Match.tsx",
      "features/match/noScore.test.ts",
      "features/tailor/TailorPanel.tsx",
      "services/api/tailor.ts",
      "pages/InterviewPrep.tsx",
    ]) {
      expect([kept, existsSync(path.join(SRC, kept))]).toEqual([kept, true]);
    }
  });

  it("no Letter GEOMETRY survives anywhere in src/ (the grep is the acceptance item)", () => {
    // T1110's fifth test, and the whole point of the deletion: once the builder is gone there is
    // no US-Letter layout authority left in the frontend to drift back from. This scans ALL of
    // `src/`, not just the Studio tree that `features/studio/noLetterGeometry.test.ts` covers.
    //
    // THE ONE EXCLUSION, and why it is not a hole. `src/lib/exportHtml.ts` is the HTML print
    // FALLBACK (FREEZE B-08: "still the right path for HTML templates"; K-01 keeps
    // `routes/export.ts` indefinitely). Its `@page { size: Letter }` is not a layout authority -
    // it is the ONE place that tells Chromium what to print, and that path is Letter because
    // the browser print pipeline is. Removing it would break the fallback the spec says to keep.
    // It is named here so the exclusion is visible and so a SECOND Letter hit elsewhere still
    // fails: the exclusion is one file, not one pattern.
    //
    // The page-size NAME is not geometry: the Studio metadata now legitimately declares the
    // registry's `letter` value for `latex-medium-professional`. What must never come back is
    // a DIMENSION (11in/8.5in or their point values), which is what the patterns below catch.
    const EXCLUDED = new Set(["lib/exportHtml.ts"]);
    const PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "11in", pattern: /\b11\s*in\b/i },
      { name: "8.5in", pattern: /\b8\.5\s*in\b/i },
      { name: "8.5/11 aspect ratio", pattern: /8\.5\s*\/\s*11/ },
      { name: "11/8.5 aspect ratio", pattern: /11\s*\/\s*8\.5/ },
      { name: "the Letter height in points", pattern: /\b792\b/ },
      { name: "the Letter width in points", pattern: /\b612\b/ },
    ];
    const hits: string[] = [];
    let scanned = 0;
    for (const file of ALL_SOURCES) {
      if (EXCLUDED.has(file)) continue;
      scanned += 1;
      const source = readFileSync(path.join(SRC, file), "utf8");
      for (const { name, pattern } of PATTERNS) {
        if (pattern.test(source)) hits.push(`${file}: ${name}`);
      }
    }
    // Non-vacuity: the scan must have covered a real tree, or "zero hits" means nothing.
    expect(scanned).toBeGreaterThan(60);
    expect(hits).toEqual([]);
  });
});