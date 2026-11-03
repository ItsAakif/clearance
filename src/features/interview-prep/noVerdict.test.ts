// The no-verdict gate for the interview-prep feature (T1090).
//
// WHAT IT FORBIDS, AND WHY IT IS A FILE AND NOT A CONVENTION. 06 sec. E.6 forbids a single
// derived number, and it says of matching specifically: "the UI must not compute one either
// (guard: no arithmetic over the counts in the client)". `features/match/noScore.test.ts` is the
// precedent and it exists because a ban nobody enforces is a wish. This is the same guard for
// the prep surface, which is a NEWER surface and therefore the one more likely to grow a
// "risk score" by accident.
//
// THE THREE THINGS BANNED, AND WHAT EACH WOULD COST:
//   1. A VERDICT-SHAPED MEMBER (`score`, `percentage`, `grade`, `matchScore`, `riskLevel`) on
//      any exported type. The moment the wire has one, a client CAN ask for it, and the
//      invitation is what eventually arrives.
//   2. ARITHMETIC OVER THE COUNTS in the presentation module. Seven risk counts and four category
//      counts is a lot of numbers sitting next to each other, and "combine them into a readiness
//      score" is exactly the derivation E.6 rules out. `total`, `+`, `/`, `Math.round`,
//      `Math.max` and `reduce` over counts are all refused: a readiness number needs a sum, and
//      the sum is the forbidden step.
//   3. A COERCION of `modelAnswer` to `string`. `null` means "no answer was stored" and `""`
//      would mean "an empty answer was stored"; they are different states, and a client that
//      turns the first into the second is telling the user a question has no answer because a
//      provider was not configured.
//
// COMMENTS ARE STRIPPED before the grep, for the same reason `broker.test.ts` and
// `AppRouteTable.test.ts` strip them: the module headers DISCUSS these words in order to
// explain that they are absent, and a grep that failed on its own documentation would be
// pushed into being switched off.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const FEATURE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "").replace(/\//g, path.sep));

/** A `//` is a comment here only at the start of a line (after whitespace), or a `*` opener. */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.search(/^\s*(\/\/|\*)/) === 0 ? line.slice(0, line.search(/\S/)) : line))
    .join("\n");
}

/**
 * The same, with IMPORT LINES BLANKED OUT AS WELL.
 *
 * Needed for the arithmetic gate specifically, and for one reason: a module path is full of
 * slashes (`"@/services/api/interview"` contains `s/api`), so a naive "is there a `/` between two
 * operands" test reads a module specifier as a division. The gate is about ARITHMETIC, so the
 * import lines are removed before it looks - which cannot hide a computation, because a
 * computation is never written inside an import statement.
 */
function stripImports(source: string): string {
  return source
    .split("\n")
    .map((line) =>
      // Three shapes, because a TypeScript import statement WRAPS: the opening `import {`, the
      // continuation `} from "..."`, and a single-line `import x from "..."`. A module
      // specifier is the only place a slash appears in any of them.
      /^\s*(import|export)\b/.test(line) || /^\s*\}\s*from\b/.test(line) || /^\s*from\s+['"]/.test(line)
        ? ""
        : line,
    )
    .join("\n");
}

function codeOf(file: string): string {
  return stripLineComments(readFileSync(path.join(FEATURE_DIR, file), "utf8"));
}

function logicOf(file: string): string {
  return stripImports(stripLineComments(readFileSync(path.join(FEATURE_DIR, file), "utf8")));
}

const SOURCES = ["riskPresentation.ts", "QuestionCard.tsx", "RiskList.tsx", "RiskSeverityBadge.tsx"];

describe("no verdict-shaped member anywhere in the feature", () => {
  it("reads every source file, so a new component cannot escape the gate", () => {
    for (const file of SOURCES) {
      const source = codeOf(file);
      expect([file, source.length]).toEqual([file, expect.any(Number)]);
      expect([file, source.length > 200]).toEqual([file, true]);
    }
  });

  it("forbids the verdict-shaped WORDS on the API surface", () => {
    const api = codeOf(path.join("..", "..", "services", "api", "interview.ts"));
    for (const banned of ["score", "percentage", "matchScore", "overallScore", "grade"]) {
      expect([banned, api.toLowerCase().includes(banned.toLowerCase())]).toEqual([banned, false]);
    }
    // Non-vacuity: the raw file really does discuss the word, in a comment.
    const raw = readFileSync(path.join(FEATURE_DIR, "..", "..", "services", "api", "interview.ts"), "utf8");
    expect(raw).toContain("no `score`");
  });

  it("forbids arithmetic over the counts in the presentation module", () => {
    const source = logicOf("riskPresentation.ts");
    // A `/` BETWEEN TWO OPERANDS is a division. A module path is not, which is why the imports
    // are stripped before this looks - see `stripImports`.
    expect(["/", /[\w)\]]\s*\/\s*[\w(]/.test(source)]).toEqual(["/", false]);
    for (const banned of ["Math.round", "Math.max", "Math.min", "reduce("]) {
      expect([banned, source.includes(banned)]).toEqual([banned, false]);
    }
    // Word-bounded, so `summary` and `resume` - both of which appear in ordinary prose here -
    // are not read as an attempt to SUM the counts.
    for (const banned of ["sum", "avg", "average", "total", "ratio", "weight"]) {
      expect([banned, new RegExp(`\\b${banned}\\b`, "i").test(source)]).toEqual([banned, false]);
    }
  });

  it("keeps the two counts maps as PLAIN INTEGER RECORDS", () => {
    const api = readFileSync(path.join(FEATURE_DIR, "..", "..", "services", "api", "interview.ts"), "utf8");
    // `Record<kind, number>` - a lookup by name. Not a sum, not a ratio, not an object with a
    // computed member, which is the shape a verdict would arrive in.
    expect(api).toMatch(/riskCounts: Record<InterviewRiskKind, number>/);
    expect(api).toMatch(/questionCounts: Record<InterviewQuestionCategory, number>/);
  });
});

describe("an absent answer stays null", () => {
  it("the API type says `string | null`, and nothing coerces it", () => {
    const api = codeOf(path.join("..", "..", "services", "api", "interview.ts"));
    expect(api).toMatch(/modelAnswer: string \| null/);
    // No `modelAnswer ?? ""`, no `String(question.modelAnswer)`, no `|| ''`.
    expect(api).not.toMatch(/modelAnswer \?\? ""/);
    expect(api).not.toMatch(/modelAnswer \|\| ''/);
  });

  it("the card component renders `null` as an explanation, not as an empty box", () => {
    const card = codeOf("QuestionCard.tsx");
    expect(card).toMatch(/question\.modelAnswer !== null/);
    expect(card).toMatch(/answerStageMessage/);
  });
});