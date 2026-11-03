// THE NO-VERDICT GUARD for the two-day project engine (T1100, 06 sec. E.6).
//
// THE RULE, verbatim: "No universal score, no single number, no letter grade, no 'ATS 87/100'."
// And on the client specifically: "The UI must not compute one either."
//
// WHY THIS FEATURE NEEDS ITS OWN GUARD. The repo-wide sweep (`src/noDerivedScore.test.ts`) bans
// score-shaped NAMES and rendered percentages across every `.tsx`, which is the layer that keeps
// a number off a screen. What it cannot see is the COMBINATION: a candidate's `estimatedHours`
// and a gap's `importance` sitting next to each other is exactly the raw material for a "fit"
// figure, and one arithmetic expression over them would pass every name-based rule in the repo.
// So this file guards the thing those rules cannot: arithmetic over the counts this feature
// shows, and the shape of the members its API module declares.
//
// THE THREE LAYERS:
//   1. THE SOURCE. Every file in this directory names no verdict, presents no percentage, and
//      does no arithmetic over a count. Comments are stripped first, because these files DISCUSS
//      the banned words in order to explain that they are absent.
//   2. THE API MODULE. Its declared members, at any depth, contain no numeric verdict - the same
//      rule `src/noDerivedScore.test.ts` layer 3 applies to the other client modules, named here
//      so this feature does not depend on that file's list being extended.
//   3. THE DERIVED VALUES. `countsRows` and `budgetNote` are run over a fixture whose numbers are
//      deliberately not in proportion to anything: if either combined them, an awkward fixture
//      would show it.
//
// This is the test the task's no-score requirement targets: add a fit field and this file fails.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { budgetNote, countsRows } from "./projectPresentation";
import type { ProjectDiscoveryCounts } from "@/services/api/projectDiscovery";

const FEATURE_DIR = path.join(__dirname);
const SRC_ROOT = path.resolve(__dirname, "..", "..");
const SERVICE_FILE = path.join(SRC_ROOT, "services", "api", "projectDiscovery.ts");

/**
 * A KEY name that would introduce a verdict, anchored so it matches an identifier and not a
 * substring of an innocent word: `budgetNote` contains no verdict word, `projectPresentation`
 * contains neither, and `similarity` is not `score`.
 */
const VERDICT_WORDS = [
  "score",
  "scores",
  "scoring",
  "rating",
  "ratings",
  "grade",
  "grades",
  "percent",
  "percentage",
  "ratio",
  "fitScore",
  "matchScore",
  "overallScore",
];

/**
 * Arithmetic that could turn counts, hours or a difficulty into ONE number about a person.
 *
 * DIVISION IS DELIBERATELY NOT IN THIS LIST, and the reason is worth stating because the repo
 * bans it elsewhere: `features/match/noScore.test.ts` includes `/`, and that feature has no
 * regular-expression literals, so there `/` can only be arithmetic. This feature has them -
 * `replace(/_/g, " ")` is how a `kind` becomes readable prose - and there `/` is nearly always
 * a regex. Multiplication, which cannot be confused with anything, IS banned, and division over
 * the counts is pinned by VALUE instead: layer 3 asserts that the rows the UI renders carry the
 * server's integers unchanged, which is what a division would break.
 */
const ARITHMETIC = new RegExp(
  [
    String.raw`\bMath\.(round|floor|ceil|trunc)\b`,
    String.raw`\.toFixed\s*\(`,
    String.raw`\.toPrecision\s*\(`,
    String.raw`\b(parseInt|parseFloat)\s*\(`,
    String.raw`[\w$)\]]\s*\*\s*[\w$([{]`,
  ].join("|"),
);

/** A percentage glued to a rendered value. */
const PRESENTED_PERCENTAGE = /\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}\s*%/;

/** Comments removed. Strings KEPT: a percentage in a sentence a human reads is layer 1's job. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Comments AND string literals removed, for the NAME check only.
 *
 * The split is the rule, not a convenience: a banned word in a SENTENCE is prose - "the hours are
 * a budget, not a rating" - while the same word in an IDENTIFIER is a name a value can arrive
 * under. The repo-wide guard makes the same distinction with its label-anchored rules
 * (`src/noDerivedScore.test.ts`); blanking the literals gets there without re-implementing them.
 */
function identifiersOnly(source: string): string {
  return codeOnly(source)
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function mentions(source: string, word: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`, "i").test(source);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every source in this feature, tests excluded. */
const SOURCES = walk(FEATURE_DIR)
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => path.relative(SRC_ROOT, file).replace(/\\/g, "/"));

describe("layer 1: no component or module in this feature names or presents a verdict", () => {
  it("the sweep covers a real tree (a walk that found nothing would pass vacuously)", () => {
    assert.ok(SOURCES.length >= 5, `expected several files to guard, found ${SOURCES.length}`);
    assert.ok(SOURCES.includes("features/project-discovery/ProjectDiscoveryPage.tsx"));
  });

  for (const file of SOURCES) {
    it(`${file} names no verdict, presents no percentage and does no arithmetic over a count`, () => {
      const rendered = codeOnly(readFileSync(path.join(SRC_ROOT, file), "utf8"));
      const identifiers = identifiersOnly(readFileSync(path.join(SRC_ROOT, file), "utf8"));
      for (const word of VERDICT_WORDS) {
        assert.ok(!mentions(identifiers, word), `${file} names "${word}"`);
      }
      assert.ok(!PRESENTED_PERCENTAGE.test(rendered), `${file} renders a percentage of a value`);
      assert.ok(!ARITHMETIC.test(rendered), `${file} does arithmetic that could produce one number`);
    });
  }
});

describe("layer 2: the client API module declares no numeric verdict member", () => {
  const code = codeOnly(readFileSync(SERVICE_FILE, "utf8"));
  const MEMBER_DECLARATION = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm;

  it("no declared member, at any depth, is a numeric verdict", () => {
    const offenders: string[] = [];
    for (const [, name] of code.matchAll(MEMBER_DECLARATION)) {
      if (VERDICT_WORDS.includes(name.toLowerCase())) offenders.push(name);
    }
    assert.deepEqual(offenders, []);
  });

  it("the counts carry exactly the four named things, and nothing derived", () => {
    const block = code.match(/export interface ProjectDiscoveryCounts \{[\s\S]*?\n\}/);
    assert.ok(block, "expected ProjectDiscoveryCounts to still be declared");
    const members = [...block![0].matchAll(MEMBER_DECLARATION)].map((match) => match[1]);
    assert.deepEqual(members.sort(), ["candidates", "considered", "excluded", "selected"]);
  });

  it("NON-VACUITY: the honest numbers are still there - the budget and the integer counts", () => {
    // "No verdict" has to mean "a named alternative exists". If this interface were emptied, the
    // feature would have replaced a number with nothing.
    const block = code.match(/export interface ProjectOpportunity \{[\s\S]*?\n\}/);
    assert.ok(block, "expected ProjectOpportunity to still be declared");
    const members = [...block![0].matchAll(MEMBER_DECLARATION)].map((match) => match[1]);
    assert.ok(members.includes("estimatedHours"), "the two-day budget is a real member");
    assert.ok(members.includes("difficulty"), "the three named words are a real member");
    assert.ok(members.includes("awaitingYourConfirmation"), "the loop's promise is a real member");
  });
});

describe("layer 3: the derived values are read, not computed", () => {
  it("countsRows renders the server's numbers in its order, and adds nothing", () => {
    // Deliberately NOT in proportion to anything: 7 considered, 3 selectable, 4 refused, 2
    // candidates. A client that rescaled or combined them would produce different numbers here.
    const counts: ProjectDiscoveryCounts = { considered: 7, selected: 3, excluded: 4, candidates: 2 };
    const rows = countsRows(counts);
    assert.deepEqual(
      rows.map((row) => row.value),
      [7, 3, 4, 2],
    );
    assert.deepEqual(
      rows.map((row) => typeof row.value),
      ["number", "number", "number", "number"],
    );
    // No row carries a figure of its own: a label and the server's integer, nothing else.
    assert.deepEqual(
      rows.map((row) => Object.keys(row).sort()),
      [["label", "value"], ["label", "value"], ["label", "value"], ["label", "value"]],
    );
    assert.ok(rows.every((row) => Number.isInteger(row.value)));
  });

  it("budgetNote states the budget and the hours, and never a proportion of them", () => {
    for (const hours of [1, 4, 10, 16, 30, 0]) {
      const note = budgetNote(hours);
      assert.ok(!note.includes("%"), "no percentage of the budget");
      assert.ok(note.includes(String(hours)), "the hours the candidate claims are stated");
      assert.ok(note.includes("16"), "the budget is named, so the hours can be read against it");
    }
  });
});