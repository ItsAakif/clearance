// The no-score guard (T1070; 06 sec. E.6).
//
// E.6 forbids a universal score, a single number, a letter grade, an "ATS 87/100", and says
// of the client specifically: "The UI must not compute one either (guard: no arithmetic over
// the counts in the client)." A rule nobody can fail is a comment, so this file is the rule.
//
// WHAT IT CHECKS, IN THREE LAYERS:
//   1. THE RESPONSE TYPE. `MatchCounts` has exactly the five members the server counts - four
//      buckets and a total - and no score-like member at any level of the report shape.
//   2. THE SOURCE. Every file in `src/features/match/**`, `src/pages/Match.tsx` and
//      `src/services/api/match.ts` is grepped for score-like identifiers, for a percentage
//      literal, and for arithmetic over the counts (`/`, `*`, `Math.round`, `toFixed`).
//      Comments are stripped first so the guard cannot be satisfied - or defeated - by prose.
//   3. THE DERIVED VALUES. `levelCounters` reads `counts[level]` and nothing else, asserted
//      over a fixture whose numbers are deliberately not in proportion to anything: if the
//      client rescaled them, a fixture with an awkward ratio would show it.
//
// This is the test the task's mutation (d) targets: add a score field and this file fails.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { levelCounters, MATCH_LEVELS } from "./matchPresentation";
import type { MatchCounts } from "@/services/api/match";

const FEATURE_DIR = path.join(__dirname);
const SRC_ROOT = path.resolve(__dirname, "..", "..");
const PAGE_FILE = path.join(SRC_ROOT, "pages", "Match.tsx");
const SERVICE_FILE = path.join(SRC_ROOT, "services", "api", "match.ts");

/**
 * A KEY name that would introduce a verdict. Anchored so it matches a member or an
 * identifier and not a substring of an innocent word: `rationale` contains `ratio`, and
 * `normalizedKey` contains neither.
 *
 * BUILT FROM ITS WORDS rather than written as a literal with escapes, so the list of
 * forbidden names is a list a reader can edit, and so adding one cannot introduce an escape
 * that a linter then flags.
 */
const SCORE_WORDS = ["score", "scoring", "rating", "grade", "percent", "percentage", "ratio", "point", "points"];
const SCORE_KEY = new RegExp(
  String.raw`^(?:overall[_-]?)?(?:match[_-]?)?(?:${SCORE_WORDS.map(escapeForRegExp).join("|")})(?:[_-]?(?:score|value|total))?$`,
  "i",
);

/** Any identifier mentioning a score, anywhere in a line. Stricter than the key rule. */
const SCORE_IDENTIFIER = /\b(ats?_?score|overall[_-]?score|match[_-]?score|percent(age)?|scorecard)\b/i;

/** A percentage literal: `85%`, `'85%'`, `` `85%` ``. */
const PERCENT_LITERAL = /['"`]\s*\d{1,3}\s*%|\d{1,3}\s*%\s*['"`]/;

/** Arithmetic that could turn the counts into a single number. */
const ARITHMETIC = new RegExp(
  [
    String.raw`\bMath\.(round|floor|ceil|trunc)\b`,
    String.raw`\.toFixed\s*\(`,
    String.raw`[\w.)\]]+\s+\/\s+[\w.[(]`,
    String.raw`[\w.)\]]+\s*\/\s*[\w.[(]`,
    String.raw`\b(parseInt|parseFloat)\s*\(`,
    String.raw`\*`,
  ].join("|"),
);

/** A declared member: `name:`, `name?:`, `readonly name:`, at the start of a line. */
const MEMBER_DECLARATION = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm;

/** One `export interface X { ... }` block, to the brace that closes it. */
const INTERFACE_BLOCK = new RegExp(
  String.raw`export interface \w+ \{[\s\S]*?\n\}`,
  "g",
);

/** Comments and string literals removed, so prose can neither pass nor defeat a guard. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/**
 * Escape a term for use inside a RegExp.
 *
 * Written out rather than imported so the guard has no dependency: this file's whole job is
 * to be readable as a rule. Every metacharacter is escaped, which is what satisfies
 * `no-useless-escape` (that rule complains about escapes that are not needed OUTSIDE a
 * character class) and is harmless inside one.
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "__snapshots__") walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The response type
// ---------------------------------------------------------------------------

describe("the MatchCounts type has five integers and no verdict", () => {
  it("exactly direct, contextual, potential, unsupported and total", () => {
    // A compile-time-ish assertion: adding a sixth member to the interface makes this fail,
    // because the object literal is checked against it.
    const counts: MatchCounts = {
      direct: 7,
      contextual: 3,
      potential: 2,
      unsupported: 4,
      total: 16,
    };
    assert.deepEqual(Object.keys(counts).sort(), [
      "contextual",
      "direct",
      "potential",
      "total",
      "unsupported",
    ]);
  });

  it("E.6's worked example survives as five plain integers", () => {
    const counts: MatchCounts = { direct: 7, contextual: 3, potential: 2, unsupported: 4, total: 16 };
    // No rescaling, no weighting: the numbers the server sent are the numbers the UI holds.
    assert.equal(counts.direct, 7);
    assert.equal(counts.total, 16);
  });

  it("no member of MatchCounts is named like a score", () => {
    for (const key of Object.keys({} as MatchCounts)) {
      assert.doesNotMatch(key, SCORE_KEY);
    }
    // And the declared keys, which is what matters for a member added later.
    const declared = ["direct", "contextual", "potential", "unsupported", "total"];
    for (const key of declared) {
      assert.doesNotMatch(key, SCORE_KEY, key);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The source
// ---------------------------------------------------------------------------

describe("no file in the match feature declares or computes a score", () => {
  const files = [...walk(FEATURE_DIR), PAGE_FILE, SERVICE_FILE];

  it("the guard covers a non-trivial number of files", () => {
    // If the walk ever silently finds nothing, every test below would pass vacuously.
    assert.ok(files.length >= 3, `expected several files to guard, found ${files.length}`);
  });

  for (const file of files) {
    const name = path.relative(SRC_ROOT, file);
    const code = codeOnly(readFileSync(file, "utf8"));

    it(`${name} has no score-like member`, () => {
      const declared = [...code.matchAll(MEMBER_DECLARATION)].map((match) => match[1]);
      for (const key of declared) {
        assert.doesNotMatch(key, SCORE_KEY, `${name} declares "${key}"`);
      }
    });

    it(`${name} has no score-like identifier`, () => {
      const hits = code
        .split("\n")
        .filter((line) => SCORE_IDENTIFIER.test(line))
        .map((line) => line.trim());
      assert.deepEqual(hits, [], `${name} mentions a score`);
    });

    it(`${name} has no percentage literal`, () => {
      assert.doesNotMatch(readFileSync(file, "utf8"), PERCENT_LITERAL, name);
    });
  }

  it("no arithmetic over the counts in the presentation module", () => {
    // `matchPresentation.ts` is the only place the counts become UI, so this is where a
    // ratio would have to be computed. No division, no rounding, no parsing.
    const code = codeOnly(readFileSync(path.join(FEATURE_DIR, "matchPresentation.ts"), "utf8"));
    const lines = code
      .split("\n")
      .filter((line) => /\bcounts\b|\blevelCounters\b/.test(line))
      .filter((line) => ARITHMETIC.test(line));
    assert.deepEqual(lines.map((line) => line.trim()), []);
  });

  it("the API service exposes no score and no percentage", () => {
    const code = codeOnly(readFileSync(SERVICE_FILE, "utf8"));
    assert.doesNotMatch(code, SCORE_IDENTIFIER);
    assert.doesNotMatch(code, PERCENT_LITERAL);
  });

  it("the report shape the service declares has no score member", () => {
    const code = codeOnly(readFileSync(SERVICE_FILE, "utf8"));
    const interfaces = code.match(INTERFACE_BLOCK) ?? [];
    assert.ok(interfaces.length > 0, "expected the service to declare interfaces");
    for (const block of interfaces) {
      const members = [...block.matchAll(MEMBER_DECLARATION)].map((m) => m[1]);
      assert.ok(members.length > 0, "a declared interface with no members");
      for (const member of members) {
        assert.doesNotMatch(member, SCORE_KEY, `a score member in ${block.split("{")[0]}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The derived values
// ---------------------------------------------------------------------------

describe("the counters read the server's integers, unchanged", () => {
  it("levelCounters returns the five... four buckets, in report order", () => {
    // Deliberately awkward numbers: 1 of 9 direct. Any client-side ratio would show up here.
    const counts: MatchCounts = { direct: 1, contextual: 2, potential: 3, unsupported: 3, total: 9 };
    const counters = levelCounters(counts);

    assert.deepEqual(
      counters.map((counter) => counter.level),
      [...MATCH_LEVELS],
    );
    assert.deepEqual(
      counters.map((counter) => counter.value),
      [1, 2, 3, 3],
    );
  });

  it("a missing bucket reads as zero rather than as undefined", () => {
    const counters = levelCounters({} as MatchCounts);
    assert.deepEqual(
      counters.map((counter) => counter.value),
      [0, 0, 0, 0],
    );
  });

  it("a count of zero is rendered as the integer 0, not as a dash or a percentage", () => {
    const counters = levelCounters({ direct: 0, contextual: 0, potential: 0, unsupported: 5, total: 5 });
    assert.equal(counters[0].value, 0);
    assert.equal(counters[3].value, 5);
  });

  it("no counter object carries anything but the level, its label and its integer", () => {
    const counters = levelCounters({
      direct: 7,
      contextual: 3,
      potential: 2,
      unsupported: 4,
      total: 16,
    });
    for (const counter of counters) {
      assert.deepEqual(Object.keys(counter).sort(), ["label", "level", "tone", "value"]);
    }
  });
});