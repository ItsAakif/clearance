// THE NO-SCORE GUARD (T1101; 06 sec. E.6).
//
// THE RULE, verbatim: "No universal score, no single number, no letter grade, no 'ATS 87/100'."
// And, on matching: "The UI must not compute one either (guard: no arithmetic over the counts in
// the client)." E.6's transparent output is four integer COUNTS plus gaps that are always NAMED.
//
// WHY A REPO-WIDE FILE AND NOT ANOTHER FEATURE-SCOPED ONE. `features/match/noScore.test.ts` (T1070)
// and `features/interview-prep/noVerdict.test.ts` (T1090) each guard their own feature, and both are
// kept UNCHANGED here. This is the third layer: the surfaces T1101 retired or reduced did not live
// in either feature - they were `pages/Resumes`, `pages/Applications`, `pages/Upload`, `pages/
// Index`, `components/landing/**`, `features/applications/**`, `features/jobs/**` and the nav. A
// guard scoped to one directory cannot see a score reintroduced in a sibling, and "we removed the
// widget" is only ever a fact about a moment.
//
// WHAT IT CHECKS, IN FOUR LAYERS:
//
//   1. NO COMPONENT NAMES A DERIVED SCORE. Every `.tsx` file in `src/` must be free of every
//      score-shaped identifier, and free of `toFixed(` / `toPrecision(` (the two methods that
//      ROUND a number into display text). One rule, no cleverness: a value cannot reach a screen
//      without its name appearing in the file, so forbidding the name forbids the screen.
//
//   2. NO COMPONENT SHOWS A PERCENTAGE OF A VALUE, OR NAMES A SCORE IN PROSE. Two shapes: a
//      rendered `{…}%`, and a human-readable string with a percentage in it ("Match Score: 68%",
//      "94% match"). CSS geometry (`w-[50%]`, `width="100%"`) is layout and is not a verdict, so
//      the check is deliberately anchored on the value that carries the number.
//
//   3. NO CLIENT API MODULE DECLARES A VERDICT MEMBER. `services/api/**` is where a number becomes
//      reachable by a component, so the declared member names are checked - which is what makes
//      "nothing renders it" structural rather than a promise. Plus a NON-VACUITY case: the V2
//      match report these retirements point at must still exist with its five integers.
//
//   4. A BARE `score` / `rating` / `grade` IN A PRESENTED POSITION (widened in the cutover review
//      fix). Layers 1-3 banned `overallScore`-shaped NAMES only, so `<span>Match Score:
//      {evaluation.score}</span>` - the single most obvious way to put the retired number back -
//      passed all three. The widened list is the one `features/match/noScore.test.ts:41` already
//      bans for its own feature, applied repo-wide, with the boundaries below.
//
// WHY IT IS NOT A LIST OF FORTY BANNED STRINGS. Comments are stripped before every check, because
// these files DISCUSS the removed scores in order to explain that they are gone, and a grep that
// fails on its own documentation gets switched off. The checks are about SHAPE - "does a
// score-shaped name appear", "is a percentage attached to a rendered value" - so renaming a
// component, adding a feature or reflowing a file cannot trip them.
//
// THE ONE NAMED ALLOWLIST, and the narrow rule that replaces it.
//
//   `pages/Jobs.tsx` and `features/jobs/JobFilters.tsx` are allowed to NAME `minMatchScore`,
//   because that is the RANKING path, not a presentation: `minMatchScore` is a PERSISTED column
//   on `SavedSearch` and `JobAlert` (prisma, which this task does not touch) and the backend still
//   accepts it, so a saved search created before this change keeps filtering exactly as before.
//   07 sec. F.5 freezes job discovery and FREEZE B-16 keeps the matcher as an internal signal; a
//   filter over a signal is allowed, a SCALE ON A SLIDER is not - which is why the Min Match select
//   and the "Match Score" sort option are gone from the UI while the plumbing stays.
//   Neither file may RENDER it, and that is not an allowlist: layer 2 - no rendered `{…}%` and no
//   percentage in a sentence - applies to every `.tsx` file with no exceptions. See
//   `.planning/progress/T1110-cutover-backend-and-score.md` sec. 9 for the migration this defers.
//
// THE API-LAYER ALLOWLIST THAT WAS HERE IS GONE. `RANKING_MEMBERS` used to name `overallScore` and
// `scores` as permitted DECLARED MEMBERS of `services/api/jobs.ts`, on the argument that deleting the
// member "would break the ranking path without removing a single number from a screen". That
// argument described a real constraint, and it has been resolved at the SOURCE rather than in the
// guard: `POST /jobs/:id/evaluate` and `GET /jobs/evaluations` no longer return the seven numbers
// (`backend/src/routes/jobs.ts` `JobEvaluationWire` / `toEvaluationWire`), and the one client reader
// that needed them (`features/jobs/jobSearchUtils.ts`'s `scores.cvMatch`/`scores.levelFit` fallback,
// which rescaled a 1-5 rubric into a 0-100 percentage) no longer has a member to read. So the client
// type is now HONEST about the wire and layer 3 needs no exception at all. The layer-3 positive
// control below is the reason that stays true.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SRC = path.join(__dirname);

/**
 * Identifiers that NAME a verdict. Matched case-insensitively as substrings of a JS/TS identifier,
 * which is why `minMatchScore` is spelled out separately below rather than swept up by `matchScore`
 * - it is a filter field name, not a score.
 */
const VERDICT_NAMES: readonly string[] = [
  "atsScore",
  "ats_score",
  "matchScore",
  "match_score",
  "overallScore",
  "overall_score",
  "lastATSScore",
  "last_ats_score",
  "averageMatchScore",
  "avgMatchScore",
  "compatibilityScore",
  "resumeScore",
  "qualityScore",
];

/** The RANKING field name: allowed ONLY in the one file that owns the persisted filter. */
const RANKING_FIELD = "minMatchScore";

/**
 * Identifier-SHAPED matcher, not a substring test.
 *
 * Substring matching is wrong here and demonstrably so: `minMatchScore` CONTAINS `matchScore`, so a
 * substring test either fails the file that legitimately owns the filter or forces the whole filter
 * name out of the banned list. Word boundaries make `matchScore` a different identifier from
 * `minMatchScore`, which is what it is.
 */
function mentions(source: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, "i").test(source);
}

/** Methods that ROUND a number into display text. `toLocaleString` is absent on purpose: grouping
 *  a count (`1,234`) is not a verdict, and `components/ui/chart.tsx` legitimately does it. */
const NUMBER_ROUNDING: readonly string[] = ["toFixed(", "toPrecision("];

/**
 * The files allowed to name the ranking field.
 *
 * `JobFilters.tsx` declares the filter's TYPE (`JobSearchFilters`), which still carries the field
 * because the persisted `SavedSearch.minMatchScore` column does - T1101 removed the control, not the
 * contract. `pages/Jobs.tsx` holds the `NO_RANKING_SIGNAL` constant `filterAndSortJobs` and
 * `JobListPanel` are given, plus the `DEFAULT_FILTERS` entry that clears it. Neither may RENDER it:
 * `JobFilters.tsx` has no `{…}%` and no score label any more, and layer 2 has no allowlist at all.
 *
 * What these two files must NOT do is re-acquire the number the ranking used to be built from.
 * There is none to name any more - the backend no longer returns it - so the carve-out here is
 * strictly about the FILTER'S NAME and cannot become a route back to the verdict.
 */
const RANKING_FILES: ReadonlySet<string> = new Set(["pages/Jobs.tsx", "features/jobs/JobFilters.tsx"]);

/** Layer 3: the client modules whose DECLARED members decide what a component can render. */
const CLIENT_MODULES: readonly string[] = [
  "services/api/jobs.ts",
  "services/api/resume.ts",
  "services/api/match.ts",
  "services/api/interview.ts",
  "services/api/career.ts",
  "services/api/studio.ts",
  "services/api/tailor.ts",
  "services/api/templates.ts",
];

/**
 * A declared member: `name:`, `name?:`, `readonly name:`, at the start of a line.
 */
const MEMBER_DECLARATION = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm;

/**
 * The declared type TEXT of a member, so "is this number reachable?" is a fact and not a guess.
 *
 * Brace-aware, because the member that matters most here is an OBJECT of numbers
 * (`scores: { cvMatch: number; … }`) and a per-line read would see only `{`. That example is now a
 * PLANTED control rather than a live member - see the last test in this file - but the walk still
 * has to be brace-aware to catch it.
 */
function declaredTypeText(source: string, colonAt: number): string {
  let depth = 0;
  let text = "";
  for (let at = colonAt; at < source.length; at += 1) {
    const ch = source[at];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) break;
      depth -= 1;
    } else if ((ch === ";" || ch === "\n") && depth === 0) break;
    text += ch;
  }
  return text;
}

/** Every declared member of a client module, with the text of its declared type. */
export function declaredMembers(code: string): Array<{ name: string; type: string }> {
  return [...code.matchAll(MEMBER_DECLARATION)].map((match) => ({
    name: match[1],
    type: declaredTypeText(code, match.index + match[0].length),
  }));
}

/**
 * The verdict members a client module may DECLARE: none. `apiModuleOffenders` is the one function
 * the layer-3 sweep and its positive controls share, so there is no allowlist left for a control to
 * hide behind - a declared numeric verdict member in a client API module is an offender, full stop.
 */
export function apiModuleOffenders(code: string): string[] {
  return declaredMembers(code)
    .filter(({ name, type }) => {
      if (VERDICT_NAMES.some((known) => name.toLowerCase() === known.toLowerCase())) return true;
      // The WIDENED clause: a bare verdict word is a reachable number only when its declared type
      // IS a number, at any depth - so `scores: { cvMatch: number }` is caught and
      // `score?: string` (a GPA the candidate typed) is not.
      return BARE_VERDICT_WORDS.includes(name.toLowerCase()) && /\bnumber\b/.test(type);
    })
    .map(({ name }) => name);
}

/**
 * Comments removed, and nothing else.
 *
 * Deliberately NOT removing string literals: a percentage inside a string a human reads is exactly
 * what layer 2 is for, and blanking strings would hide it.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

const SOURCES = walk(SRC).map((file) => path.relative(SRC, file).replace(/\\/g, "/"));
const TSX = SOURCES.filter((file) => file.endsWith(".tsx"));

const codeOf = (file: string): string => codeOnly(readFileSync(path.join(SRC, file), "utf8"));

/**
 * Every `{ … }` run with no nested brace that is IMMEDIATELY followed by a `%`.
 *
 * Matched over the source rather than over a captured `{…}` group, and the difference matters: the
 * `%` sits OUTSIDE the closing brace, so slicing the brace group first and then looking for the `%`
 * inside it can never match. (A mutation that put `{insights.breakdown.skills}% match` back into
 * `JobDetailPanel` is what caught that - the guard passed it until this was fixed.)
 */
function presentedPercentages(source: string): string[] {
  return [...source.matchAll(/\{[^{}]*\}\s*%/g)].map((match) => match[0].trim());
}

/**
 * THE CLOSED INVENTORY of percentages that are NOT a verdict.
 *
 * A blanket "no `{…}%` in any component" rule would be wrong, and it is wrong in both directions:
 * it would reject a progress bar's own `translateX(-${100 - value}%)`, and - worse - an
 * allowlist that grows silently is not a guard. So the remaining sites are enumerated EXACTLY, and
 * a fifth one fails until somebody writes down why it is allowed. Each entry is a percentage whose
 * DENOMINATOR THE READER CAN SEE and which is not derived from a quality score:
 *
 *  - `progress.tsx`      a `Progress` bar's own transform. LAYOUT.
 *  - `sidebar.tsx`       a decorative rail's width. LAYOUT.
 *  - `ApplicationAnalytics` responses / applications sent. A rate over a visible denominator, and
 *                         it is the application's OWN outcome - not a judgement of the resume.
 *  - `Insights.tsx`      the measure bar's own width. The denominator is the chart's own maximum
 *                        count, not a quality score.
 *
 * `pages/Profile.tsx` USED to be here for its required-field percentage meter. That meter is
 * gone: the panel now says "N of M required fields set" and lists the missing names, so there is
 * no percentage left to allow (and a leftover allowance fails the closed-inventory test below).
 */
const ALLOWED_PERCENTAGES: readonly string[] = [
  "components/ui/progress.tsx",
  "components/ui/sidebar.tsx",
  "features/applications/ApplicationAnalytics.tsx",
  "pages/Insights.tsx",
];

// ================================ LAYER 4: A BARE VERDICT WORD, PRESENTED ==================
//
// WHY THIS LAYER EXISTS. Layers 1-3 ban NAMES (`overallScore`, `matchScore`, ...) and PERCENTAGES.
// They do not ban the obvious word, so this passed every layer before the fix:
//
//     <span>Match Score: {evaluation.score}</span>          <- no VERDICT_NAMES identifier
//                                                          <- no `{…}%`
//                                                          <- `score` is not a declared member of
//                                                             any CLIENT_MODULE, so layer 3 is silent
//
// `BARE_VERDICT_WORDS` is the set `features/match/noScore.test.ts:41` already bans inside
// `src/features/match/**`; that guard was scoped to one feature and the vocabulary was never
// widened to the repo. These three words are what people actually type when they put the number
// back.
//
// THE BOUNDARY, STATED PRECISELY, because "just ban the word" is the wrong rule twice over.
//
//   FLAGGED (a presented position), in any `.tsx`:
//     L4-a  A JSX LABEL - literal JSX text whose LAST word is a verdict word, because that is what
//           a label is: "Match Score: ", "Grade ", "Rating ". The `>` must be preceded by a word
//           character, a quote, `}` or `>`, which is what a TAG close looks like; a `>` preceded by
//           a space is a comparison (`count > score`). Anchoring on the END of the run is what keeps
//           honest PROSE out of it: `pages/Match.tsx`'s "…a list of named gaps - no score, and
//           nothing counted as your experience until you confirm it" mentions the word and presents
//           nothing, and `pages/Index.tsx`'s "…without breaking formatting or guessing scores."
//           does the same. A word immediately followed by a DIGIT ("Score 87") is flagged too.
//     L4-b  A JSX EXPRESSION CONTAINER - the inside of a `{ … }` pair, which is how a value gets
//           onto a screen (`{evaluation.score}`, `{"Match Score"}`, `{score}`). A pair that is an
//           IMPORT clause (removed first), a BLOCK (a function or class body - the braces a
//           component's own code lives in, which is not a render), an OBJECT LITERAL
//           (`{ score: value }` declares a member) or a DESTRUCTURING (`const { score } = …`, whose
//           `}` is followed by `=`) is a declaration, not a render, and is skipped.
//     L4-c  A MEMBER READ - `.score`, `.grade`, `.rating`, … anywhere. This is the shape that
//           escapes L4-b, because an attribute value's braces are preceded by `=`:
//           `<Badge grade={job.grade}>`.
//     L4-d  A FORMATTED NUMBER - the word immediately followed by `.toFixed(`, `.toPrecision(` or
//           `%`. The methods are already banned outright by layer 1; this names the intent, and it
//           is the only rule that fires on `score.toFixed(0)` when the word is reached through a
//           variable the component computed itself.
//
//   NOT FLAGGED (and deliberately so):
//     - a local variable that is never rendered: `const score = compute();` appears in no JSX
//       text, no `{…}` container, no member read and no format call, so it is invisible to L4.
//       Proving "never rendered" needs an AST and a data-flow pass; approximating it with a
//       name list is exactly the brittleness this file is written to avoid.
//     - `import { Percent } from 'lucide-react'` - the module clause is removed before L4 runs,
//       because an ICON COMPONENT is not a presented percentage. `features/applications/
//       ApplicationAnalytics.tsx` is the live example and it is why the removal exists.
//     - `minMatchScore` in `RANKING_FILES` - the identifier-boundary matcher already treats it as
//       a different word from `score`, which is what it is.
//     - the internal scanners' own naming (`scoreResumeAgainstJob`, `matcher.matchScore`,
//       `evaluation/matcher.ts`). Layers 1-2 are `.tsx`-only and layer 3 is `services/api/**`-only,
//       so the deterministic signals stay named for what they are - FREEZE B-16/B-17/B-18 exist
//       because the scorer is allowed to be a scorer as long as nothing renders it.

const BARE_VERDICT_WORDS: readonly string[] = [
  "score",
  "scores",
  "rating",
  "ratings",
  "grade",
  "grades",
  "percent",
  "percentage",
  "ratio",
];

/** The bare words, matched case-insensitively and NOT inside a longer identifier or a member read. */
const BARE_WORD = new RegExp(`(?<![\\w$.])\\b(?:${BARE_VERDICT_WORDS.join("|")})\\b`, "i");

/**
 * A verdict word that is the LAST thing in a run of JSX text: the label shape.
 *
 * `Match Score: ` and `Grade ` end in a verdict word; `…no score, and nothing counted as your
 * experience until you confirm it` does not, and neither does `…or guessing scores.` (`scores` is
 * followed by a full stop, and a full stop is not a value).
 */
const LABEL_AT_END = new RegExp(`\\b(?:${BARE_VERDICT_WORDS.join("|")})\\b[\\s:.-]*$`, "i");

/**
 * A NEGATED label is prose, not a verdict: "Self-hosted. No scores." mentions the
 * removed number in order to say it is absent. The landing page's eyebrow pill is
 * the live case (the copy is fixed by the design contract), and this is exactly
 * the "prose mentions the word and presents nothing" boundary documented above.
 * A negated label that then presents a DIGIT is still caught by
 * `LABEL_THEN_NUMBER`, so "No score: 87" stays a positive control.
 */
const NEGATED_LABEL = new RegExp(
  `\\b(?:no|not|never|without|nor)\\s+(?:a\\s+|any\\s+)?(?:${BARE_VERDICT_WORDS.join("|")})\\b[\\s:.-]*$`,
  "i",
);

/** The same word immediately followed by a DIGIT - "Score 87", "87% grade". */
const LABEL_THEN_NUMBER = new RegExp(
  `\\b(?:${BARE_VERDICT_WORDS.join("|")})\\b[\\s:.-]*\\d`,
  "i",
);

/**
 * `evaluation.score`, `job.grade`, `job.ratings` - a MEMBER READ, wherever it is.
 *
 * The dot is what makes this precise and needs no lookbehind: `AspectRatioPrimitive` and
 * `aspect-square` contain the letters without a `.` in front of them, and `\b` stops `foo.aspectScore`
 * from matching on `aspect`. This is the rule that catches the shape a JSX label cannot -
 * an ATTRIBUTE value, whose braces are preceded by `=`: `<Badge grade={job.grade}>`.
 */
const MEMBER_READ = new RegExp(`\\.\\s*(?:${BARE_VERDICT_WORDS.join("|")})\\b`, "i");

/** `score.toFixed(0)`, `rating}%`, `grade.toPrecision(1)`. */
const FORMATTED_VERDICT = new RegExp(
  `\\b(?:${BARE_VERDICT_WORDS.join("|")})\\s*(?:\\.\\s*toFixed\\(|\\.\\s*toPrecision\\(|%)`,
  "i",
);

/**
 * `import …;` clauses removed, and nothing else.
 *
 * Necessary, and for a stated reason rather than a general one: the icon component `Percent` is
 * named by an import and rendered as an icon, which is not a presented percentage. Both the
 * single-line form and the multi-line list form are removed (a clause always ends at its first
 * `;` or at the end of the `from '…'` specifier).
 */
function withoutModuleClauses(source: string): string {
  return source
    .replace(/(^|\n)[ \t]*import\b[^;]*;/g, "$1")
    .replace(/(^|\n)[ \t]*import\b[^;]*?from\s*['"][^'"]*['"][ \t]*(?=\n)/g, "$1");
}

/**
 * EVERY `{ … }` pair, nested ones included, with the inner text and the index of the `{`.
 *
 * Nested, because a JSX container lives INSIDE a function body and the body itself is not a render;
 * skipping past an outer span would make every container inside it invisible.
 */
function braceSpans(source: string): Array<{ inner: string; open: number; end: number }> {
  const spans: Array<{ inner: string; open: number; end: number }> = [];
  for (let i = source.indexOf("{"); i !== -1; i = source.indexOf("{", i + 1)) {
    let depth = 0;
    let at = i;
    for (; at < source.length; at += 1) {
      const ch = source[at];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    spans.push({ inner: source.slice(i + 1, at), open: i, end: at });
  }
  return spans;
}

/** The last non-whitespace character before `at`, and whether only whitespace separates them. */
function precedingToken(source: string, at: number): { char: string | undefined; onlySpaceBefore: boolean } {
  let j = at - 1;
  while (j >= 0 && /\s/.test(source[j])) j -= 1;
  let line = source.lastIndexOf("\n", at);
  if (line === -1) line = 0;
  return { char: j >= 0 ? source[j] : undefined, onlySpaceBefore: source.slice(line, at).trim() === "" };
}

/** The first non-whitespace character after `at`, or `undefined` at the end of the file. */
function followingToken(source: string, at: number): string | undefined {
  let j = at + 1;
  while (j < source.length && /\s/.test(source[j])) j += 1;
  return j < source.length ? source[j] : undefined;
}

/**
 * Characters that turn a `{ … }` pair into a DECLARATION rather than a render.
 *
 * `=` a destructuring (`const { score } = x`) or a type annotation (`{ a }: Props`);
 * `:` the same, on a typed parameter (`function f({ count, score }: Props)`);
 * `)` `,` `;` a parameter list, an argument list, a statement - `{ a, b }: T` and
 * `({ count, score }: Props)` are declarations, never JSX.
 *
 * What is deliberately NOT here: `<`, because `<span>{x}</span>` is a render and nothing else.
 */
const DECLARATION_FOLLOWERS = new Set(["=", ":", ")", ",", ";"]);

/**
 * Is this `{` a BLOCK - a function body, a class body, a bare statement block - rather than a render?
 *
 * Getting this wrong in either direction is a real failure: call every block a render and
 * `ApplicationAnalytics.tsx`'s metrics array is flagged for the lucide `Percent` icon; call every
 * render a block and `Match Score: {x}` is not caught. The tests below pin both directions.
 */
function isBlockOpen(source: string, open: number): boolean {
  const before = precedingToken(source, open);
  const char = before.char;
  if (char === undefined) return true; // the start of the file
  if (char === ")") return true; // `function f() {`, `if (…) {`
  if (char === ">" && source[open - 2] === "=") return true; // `=> {`
  if (char === ">" || char === "(") return false; // a JSX tag close, or an open paren in JSX
  return before.onlySpaceBefore; // `try {`, `class X {` - a brace that starts a line
}

/** A `{ … }` whose top level declares a member (`{ score: value }`, `{ x ? a : b }`). */
function declaresAMember(inner: string): boolean {
  let depth = 0;
  for (const ch of inner) {
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) return true;
  }
  return false;
}

/**
 * Every position in which a bare verdict word would be ON A SCREEN.
 *
 * Returns human-readable labels, not booleans, so a failure names the shape that tripped it - the
 * same discipline every other rule in this file follows.
 */
export function presentedBareVerdict(source: string): string[] {
  const code = withoutModuleClauses(source);
  const offenders: string[] = [];
  const lineAt = (index: number): number => code.slice(0, index).split("\n").length;

  // L4-a - a JSX label. The lookbehind is what makes the `>` a TAG close and not a comparison:
  // `<span>Match Score` has `n>`; `count > score` has ` >`.
  for (const match of code.matchAll(/(?<=[\w"'`}>])>([^<>{}]*)/g)) {
    const run = match[1];
    const negated = NEGATED_LABEL.test(run.trim());
    if ((LABEL_AT_END.test(run) && !negated) || LABEL_THEN_NUMBER.test(run)) {
      offenders.push(`jsx label \`${run.trim()}\` at line ${lineAt(match.index ?? 0)}`);
    }
  }

  // L4-b - a JSX expression container. Four shapes of `{…}` are a DECLARATION rather than a render
  // and are skipped: a block (a function body), an attribute value (the `{` is preceded by `=`, as
  // in `icon={Percent}`), an object literal (`{ score: value }`) and a binding or parameter list
  // (`DECLARATION_FOLLOWERS`).
  for (const span of braceSpans(code)) {
    if (isBlockOpen(code, span.open)) continue;
    if (precedingToken(code, span.open).char === "=") continue;
    if (declaresAMember(span.inner)) continue;
    const next = followingToken(code, span.end);
    if (next !== undefined && DECLARATION_FOLLOWERS.has(next)) continue;
    const hit = span.inner.match(BARE_WORD);
    if (hit) {
      offenders.push(`expression \`{${hit[0].trim()}}\` at line ${lineAt(span.open)}`);
    }
  }

  // L4-c / L4-d.
  if (MEMBER_READ.test(code)) offenders.push(`member read \`${code.match(MEMBER_READ)![0]}\``);
  if (FORMATTED_VERDICT.test(code)) offenders.push(`formatted \`${code.match(FORMATTED_VERDICT)![0]}\``);

  return offenders;
}

/**
 * Layers 1, 2 and 4 for one component file, as ONE function.
 *
 * The per-file `it()` blocks and the planted-file positive controls BOTH go through this, which is
 * what makes the controls meaningful: a control that passes proves the rule functions reject the
 * snippet, and a control that fails proves they do not - without a control ever depending on a
 * different code path than the sweep.
 */
export function componentOffenders(file: string, code: string): string[] {
  const offenders: string[] = [];
  if (!RANKING_FILES.has(file)) {
    for (const name of [...VERDICT_NAMES, RANKING_FIELD]) {
      if (mentions(code, name)) offenders.push(`name:${name}`);
    }
  }
  for (const method of NUMBER_ROUNDING) {
    if (code.includes(method)) offenders.push(method);
  }
  offenders.push(...presentedBareVerdict(code));
  if (!ALLOWED_PERCENTAGES.includes(file)) {
    for (const percentage of presentedPercentages(code)) offenders.push(`percentage:${percentage}`);
  }
  return offenders;
}

describe("layer 1: no component in src/ can name a derived score", () => {
  it("the sweep covers a real tree (a walk that found nothing would pass vacuously)", () => {
    assert.ok(TSX.length >= 40, `expected many .tsx files to guard, found ${TSX.length}`);
  });

  for (const file of TSX) {
    it(`${file} names no verdict, presents no bare one, and rounds nothing for display`, () => {
      // `componentOffenders` is the SAME function the planted-file positive controls below run, so
      // this sweep and the controls can never disagree about what the guard means.
      assert.deepEqual(componentOffenders(file, codeOf(file)), [], file);
    });
  }
});

describe("layer 2: no component shows a percentage of a value, or names a score in prose", () => {
  for (const file of TSX) {
    it(`${file} presents no percentage of a value`, () => {
      const offenders = ALLOWED_PERCENTAGES.includes(file) ? [] : presentedPercentages(codeOf(file));
      assert.deepEqual(offenders, [], file);
    });
  }

  it("the allowance list is CLOSED - the set of files with a percentage is exactly the list", () => {
    // The inventory is an assertion, not a permission slip: a NEW `{…}%` anywhere in the app fails
    // here until somebody names it and says why, and an allowance that stops being used fails too
    // (a stale entry is as much a lie as a new one).
    const withPercentages = TSX.filter((file) => presentedPercentages(codeOf(file)).length > 0).sort();
    assert.deepEqual(withPercentages, [...ALLOWED_PERCENTAGES].sort());
  });

  it("no component bakes a percentage into a sentence a human reads", () => {
    // Two or more words then a percentage: "94% match", "Score: 87%". One word plus a number is a
    // CSS value or an SVG attribute and is layout, not a verdict - and neither is a PLACEHOLDER,
    // which is text the USER types rather than a number the app shows. `pages/CareerProfile.tsx`'s
    // `placeholder="e.g. Reduced p99 latency by 40%"` is the reason those attributes are cut out.
    const CUT = /\b(?:placeholder|title|aria-label|alt|label)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/g;
    const offenders: string[] = [];
    for (const file of TSX) {
      const rendered = codeOf(file).replace(CUT, " ");
      for (const match of rendered.matchAll(/([A-Za-z][\w .'-]{1,40}?)\s(\d{1,3})\s*%/g)) {
        offenders.push(`${file}: "${match[1].trim()} ${match[2]}%"`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe("layer 3: no client API module declares a verdict member", () => {
  it("every named module exists (so the sweep cannot pass on an empty list)", () => {
    for (const module of CLIENT_MODULES) {
      assert.ok(SOURCES.includes(module), `${module} is missing`);
    }
  });

  for (const module of CLIENT_MODULES) {
    it(`${module} declares no score-shaped member`, () => {
      assert.deepEqual(apiModuleOffenders(codeOf(module)), [], module);
    });
  }

  it("`MatchCounts` - the shape T1070 designed - still has exactly its five integers", () => {
    // Non-vacuity for the whole task: "no score" has to mean "a named alternative exists", not
    // "nothing is shown". If this interface were ever emptied out, the retirements would have
    // replaced a number with nothing.
    const block = codeOf("services/api/match.ts").match(/export interface MatchCounts \{[\s\S]*?\n\}/);
    assert.ok(block, "expected MatchCounts to still be declared");
    const members = [...block![0].matchAll(MEMBER_DECLARATION)].map((match) => match[1]);
    assert.deepEqual(members.sort(), ["contextual", "direct", "potential", "total", "unsupported"]);
  });
});

describe("layer 4: a bare score/rating/grade is not allowed ON A SCREEN", () => {
  // The three PLANTS the review named. Each is the obvious way somebody puts the number back, and
  // each is planted in a FILE ON DISK and read back through the sweep's own code path - so a
  // control cannot pass by testing a different function than the tree is tested with.
  const PLANTS: ReadonlyArray<{ what: string; name: string; source: string; bareWord: boolean }> = [
    {
      what: "a bare `score` used as a LABEL - the case the review found",
      name: "Plant.tsx",
      bareWord: true,
      source: [
        "export function Plant({ evaluation }: { evaluation: { score: number } }) {",
        "  return (",
        "    <div>",
        "      <span>Match Score: {evaluation.score}</span>",
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    },
    {
      what: "an `overallScore` RENDER - the name layers 1-3 already banned, so this plant is the",
      name: "Overall.tsx",
      bareWord: false,
      source: [
        "export function Overall({ evaluation }: { evaluation: { overallScore: number } }) {",
        "  return <p>Overall fit: {evaluation.overallScore}</p>;",
        "}",
      ].join("\n"),
    },
    {
      what: "a `score` ROUNDED into a heading",
      name: "Rounded.tsx",
      bareWord: true,
      source: [
        "export function Rounded({ evaluation }: { evaluation: { score: number } }) {",
        "  const rounded = score.toFixed(0);",
        "  return <h2>Your score: {rounded}</h2>;",
        "}",
      ].join("\n"),
    },
    {
      what: "a member read in an ATTRIBUTE value, which has no JSX label to catch it",
      name: "Badge.tsx",
      bareWord: false,
      source: [
        "export function Badge({ job }: { job: { grade: number } }) {",
        "  return <span className=\"badge\" grade={job.grade} />;",
        "}",
      ].join("\n"),
    },
  ];

  it("every planted presentation FAILS the guard, in a real file on disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "no-derived-score-"));
    try {
      for (const plant of PLANTS) {
        const file = path.join(dir, plant.name);
        writeFileSync(file, plant.source, "utf8");
        const code = codeOnly(readFileSync(file, "utf8"));
        const offenders = componentOffenders(plant.name, code);
        assert.ok(offenders.length > 0, `${plant.what}: the guard PASSED it (in ${plant.name})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a negated prose label is not a verdict, but a negated label with a number is", () => {
    // The landing eyebrow is the live safe case: it names the removed number in
    // order to say it is absent. The carve-out must not swallow a real value.
    assert.deepEqual(presentedBareVerdict("<p>Self-hosted. No scores.</p>"), []);
    assert.ok(presentedBareVerdict("<p>No score: 87</p>").length > 0);
  });

  it("the bare-word layer alone catches the two plants it is responsible for", () => {
    // Isolated from layers 1-3: plant #1 contains no VERDICT_NAMES identifier and no percentage, so
    // `presentedBareVerdict` is the ONLY rule that can catch it, and #3's `score.toFixed(0)` is
    // caught here as well as by layer 1. Plant #2 is `overallScore`, which is NOT a bare word - it
    // is layer 1's job, and this file asserts that rather than pretending otherwise.
    const dir = mkdtempSync(path.join(tmpdir(), "no-derived-score-"));
    try {
      for (const plant of PLANTS.filter((entry) => entry.bareWord)) {
        const file = path.join(dir, plant.name);
        writeFileSync(file, plant.source, "utf8");
        const offenders = presentedBareVerdict(codeOnly(readFileSync(file, "utf8")));
        assert.ok(offenders.length > 0, `${plant.what}: presentedBareVerdict PASSED it`);
      }
      const overall = PLANTS.find((entry) => entry.name === "Overall.tsx")!;
      assert.deepEqual(
        presentedBareVerdict(codeOnly(overall.source)),
        [],
        "`overallScore` is not a bare word - layer 1 catches it, and this pins that split",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the legitimate identifiers the rule must NOT flag are not flagged", () => {
    // The negative controls. Without these, "ban the word everywhere" would also pass - and it would
    // be wrong: it fails on the lucide `Percent` ICON, on a comparison, and on the persisted
    // ranking filter, and it would push the next developer towards a rename instead of towards not
    // presenting a number.
    const SAFE: ReadonlyArray<{ what: string; name: string; source: string }> = [
      {
        what: "a local variable named `score` that is never rendered",
        name: "Local.tsx",
        source: [
          "export function Local({ count }: { count: number }) {",
          "  const score = count * 2;",
          "  return <p>{count} items</p>;",
          "}",
        ].join("\n"),
      },
      {
        what: "the lucide `Percent` ICON, imported and rendered",
        name: "Icon.tsx",
        source: [
          "import { BarChart3, Percent } from 'lucide-react';",
          "export function Icon() {",
          "  return <BarChart3 icon={Percent} />;",
          "}",
        ].join("\n"),
      },
      {
        what: "a comparison, `count > score`, whose `>` is not a tag close",
        name: "Compare.tsx",
        source: [
          "export function Compare({ count, score }: { count: number; score: number }) {",
          "  const better = count > score;",
          "  return <p>{String(better)}</p>;",
          "}",
        ].join("\n"),
      },
      {
        what: "`minMatchScore`, the persisted ranking filter, in its own file",
        name: "pages/Jobs.tsx",
        source: "export const build = (minMatchScore: number) => minMatchScore;",
      },
      {
        what: "`AspectRatioPrimitive` and the `aspect-square` class, which contain the letters",
        name: "Aspect.tsx",
        source: [
          "import * as AspectRatioPrimitive from '@radix-ui/react-aspect-ratio';",
          "export function Aspect({ children }: { children: React.ReactNode }) {",
          "  return <AspectRatioPrimitive.Root className=\"aspect-square\">{children}</AspectRatioPrimitive.Root>;",
          "}",
        ].join("\n"),
      },
    ];
    const dir = mkdtempSync(path.join(tmpdir(), "no-derived-score-"));
    try {
      for (const safe of SAFE) {
        const file = path.join(dir, path.basename(safe.name));
        writeFileSync(file, safe.source, "utf8");
        const code = codeOnly(readFileSync(file, "utf8"));
        assert.deepEqual(presentedBareVerdict(code), [], `${safe.what}: presentedBareVerdict flagged it`);
        assert.deepEqual(componentOffenders(safe.name, code), [], `${safe.what}: the guard flagged it`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a client module declaring a NUMERIC bare verdict member fails layer 3; a STRING one does not", () => {
    // The type-text boundary, in both directions. `score?: string` is `StudioEducationEntry`'s GPA
    // field - text the candidate typed about their own education - and E.6 forbids a derived
    // VERDICT, not a person's own grade. `score: number` is a number a component could render, and
    // `ratings: { … number … }` is the same number one grain finer.
    const numeric = ["export interface Match {", "  score: number;", "  detail: string;", "}"].join("\n");
    const asString = ["export interface Match {", "  score?: string;", "}"].join("\n");
    const objectOfNumbers = [
      "export interface JobEvaluation {",
      "  ratings: { technical: number; culture: number; };",
      "}",
    ].join("\n");

    assert.ok(apiModuleOffenders(numeric).includes("score"), "a numeric `score` member must fail");
    assert.ok(
      apiModuleOffenders(objectOfNumbers).includes("ratings"),
      "an object OF NUMBERS named `ratings` must fail too",
    );
    assert.deepEqual(apiModuleOffenders(asString), [], "a string-typed `score` is user-authored text");
  });

  it("`JobEvaluation` declares no numeric verdict member, and re-adding either one FAILS layer 3", () => {
    // This is the test that retired `RANKING_MEMBERS`. It replaces an allowlist that existed because
    // `services/api/jobs.ts` still DECLARED `overallScore` and `scores` while the backend returned
    // them. Both members are gone now - `backend/src/routes/jobs.ts` projects them off the wire
    // (`JobEvaluationWire` / `toEvaluationWire`) - so layer 3 has no exception at all.
    //
    // Three assertions, in the same order they matter: the LIVE interface is clean, the shape the
    // honest response actually has is still there (so "clean" cannot be satisfied by emptying the
    // type), and BOTH retired members are caught when planted. The plants are the guard's own
    // positive controls: a carve-out that cannot be shown to have been needed is not a carve-out.
    const code = codeOf("services/api/jobs.ts");

    const block = code.match(/export interface JobEvaluation \{[\s\S]*?\n\}/);
    assert.ok(block, "expected JobEvaluation to still be declared");
    const members = [...block![0].matchAll(MEMBER_DECLARATION)].map((match) => match[1]);
    assert.deepEqual(
      members.sort(),
      ["id", "isScam", "jobListing", "recommendation", "reportJson", "roleSummary"],
      "JobEvaluation must declare exactly the honest members, and no verdict number",
    );
    assert.deepEqual(apiModuleOffenders(code), [], "services/api/jobs.ts");

    for (const member of ["overallScore", "scores"]) {
      assert.ok(
        !members.includes(member),
        `${member} is back on the client type; the backend no longer returns it`,
      );
    }

    // POSITIVE CONTROL 1 - the exact top-level member `POST /jobs/:id/evaluate` used to return.
    const withOverall = ["export interface JobEvaluation {", "  id: string;", "  overallScore: number;", "}"].join("\n");
    assert.ok(
      apiModuleOffenders(withOverall).includes("overallScore"),
      "re-declaring `overallScore: number` must fail layer 3 with no carve-out to hide behind",
    );

    // POSITIVE CONTROL 2 - the `scores` object of six, one grain finer than `overallScore`.
    const withScores = [
      "export interface JobEvaluation {",
      "  id: string;",
      "  scores: {",
      "    cvMatch: number;",
      "    levelFit: number;",
      "  };",
      "}",
    ].join("\n");
    assert.ok(
      apiModuleOffenders(withScores).includes("scores"),
      "re-declaring the `scores` object of numbers must fail layer 3 too",
    );
  });
});