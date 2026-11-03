// Unit tests for the pure tailoring-UI model (T1080).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts; ADR-031
// decision 3 - pure modules only, no jsdom / component tests). Everything here is therefore a
// fact about a FUNCTION, which is why the decisions the screen makes - what may be accepted,
// what gets sent, what a row shows - live in `tailorModel.ts` rather than in a component.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SCORE_FUNCTIONS_ARE_FORBIDDEN,
  acceptedOperations,
  diffRowsForChanges,
  diffRowsForOperations,
  displayValue,
  isAcceptable,
  pendingCount,
  refusalLine,
  summariseProposal,
} from "./tailorModel";
import type { TailorChangeRowWithClaims, TailorOperation } from "@/services/api/tailor";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function operation(overrides: Partial<TailorOperation> = {}): TailorOperation {
  return {
    op: "rewrite_bullet",
    target: "work[0].highlights[0]",
    before: "Cut CI build time by 40%",
    after: "Reduced the CI build time by 40%",
    reason: "mirrors the JD's throughput requirement",
    targetRequirementIds: ["req-1"],
    sourceClaimIds: ["clm-1"],
    factDelta: false,
    accepted: true,
    rejection: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. An operation the server refused cannot be accepted
// ---------------------------------------------------------------------------

describe("an operation the SERVER refused cannot be accepted", () => {
  it("isAcceptable is exactly the server's verdict, and the client's opinion is not consulted", () => {
    // The whole safety story in one line: the client does not decide. A refused operation with
    // a perfect-looking `after` is still refused, because the refusal is the fact-delta guard
    // having read the confirmed claims.
    const refused = operation({
      accepted: false,
      after: "Cut the CI build time by 40% and scaled to 12000 accounts",
      rejection: { code: "FACT_DELTA", reason: "the proposed wording introduces a fact", detail: "metric:12000" },
    });
    expect(isAcceptable(refused)).toBe(false);
    expect(acceptedOperations([refused])).toEqual([]);
  });

  it("acceptedOperations sends EXACTLY the accepted operations, in order, and nothing else", () => {
    const first = operation({ target: "work[0].highlights[0]" });
    const refused = operation({
      target: "work[0].highlights[1]",
      accepted: false,
      rejection: { code: "SOURCE_CLAIM_NOT_CONFIRMED", reason: "not confirmed", detail: "clm-2" },
    });
    const second = operation({ target: "basics.summary", op: "reword_summary" });
    expect(acceptedOperations([first, refused, second])).toEqual([
      {
        op: "rewrite_bullet",
        target: "work[0].highlights[0]",
        before: "Cut CI build time by 40%",
        after: "Reduced the CI build time by 40%",
        reason: "mirrors the JD's throughput requirement",
        targetRequirementIds: ["req-1"],
        sourceClaimIds: ["clm-1"],
      },
      {
        op: "reword_summary",
        target: "basics.summary",
        before: "Cut CI build time by 40%",
        after: "Reduced the CI build time by 40%",
        reason: "mirrors the JD's throughput requirement",
        targetRequirementIds: ["req-1"],
        sourceClaimIds: ["clm-1"],
      },
    ]);
    expect(pendingCount([first, refused, second])).toBe(2);
  });

  it("refusalLine shows the CODE and the detail, because the code is what the user acts on", () => {
    const refused = operation({
      accepted: false,
      rejection: { code: "FACT_DELTA", reason: "introduces a fact", detail: "metric:12000" },
    });
    expect(refusalLine(refused)).toBe("FACT_DELTA (metric:12000)");
    expect(refusalLine(operation())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The empty state must distinguish "no provider" from "nothing to do"
// ---------------------------------------------------------------------------

describe("the empty state says WHICH emptiness it is", () => {
  it("'no provider configured' is a different answer from 'nothing to change'", () => {
    // ADR-041 D5 made the deterministic path work without a key; if the two empty states read
    // the same, a user concludes the feature is broken rather than that no key is installed.
    const noProvider = summariseProposal([], { status: "skipped", reason: "no_ai_provider_configured" });
    const nothingToDo = summariseProposal([], { status: "ok", reason: "ok" });
    expect(noProvider.noProviderConfigured).toBe(true);
    expect(nothingToDo.noProviderConfigured).toBe(false);
    expect(noProvider.headline).not.toBe(nothingToDo.headline);
    expect(noProvider.headline).toMatch(/no ai provider/i);
    // And both say the user can still drive it by hand, because apply() takes a request body.
    expect(noProvider.headline).toMatch(/yourself/i);
  });

  it("a provider FAILURE is its own state, and never leaks a provider message", () => {
    const failed = summariseProposal([], { status: "failed", reason: "proposal_failed:Error" });
    expect(failed.providerFailed).toBe(true);
    expect(failed.noProviderConfigured).toBe(false);
    expect(failed.headline).toContain("proposal_failed:Error");
  });

  it("counts what is applicable against what was proposed", () => {
    const summary = summariseProposal(
      [
        operation(),
        operation({
          accepted: false,
          rejection: { code: "FACT_DELTA", reason: "x", detail: null },
        }),
      ],
      { status: "ok", reason: "ok" },
    );
    expect(summary).toMatchObject({ count: 2, acceptableCount: 1, refusedCount: 1 });
    expect(summary.headline).toContain("2 operations");
  });
});

// ---------------------------------------------------------------------------
// 3. The diff row shows before / after / reason / the claims
// ---------------------------------------------------------------------------

describe("the diff row shows BEFORE, AFTER, the REASON and the CLAIMS", () => {
  it("a proposed operation becomes a row with all four, and `null` rather than the string 'null'", () => {
    const rows = diffRowsForOperations([operation()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "rewrite_bullet",
      target: "work[0].highlights[0]",
      before: "Cut CI build time by 40%",
      after: "Reduced the CI build time by 40%",
      reason: "mirrors the JD's throughput requirement",
      rejectionCode: null,
      accepted: true,
    });
    // A missing value is `null`, never "null": a diff that renders the string "null" next to an
    // empty bullet is worse than one that renders nothing.
    expect(displayValue(null)).toBeNull();
    expect(displayValue(undefined)).toBeNull();
    expect(displayValue("   ")).toBeNull();
    expect(displayValue([1, 0])).toBe("[1,0]");
    expect(displayValue(0)).toBe("0");
  });

  it("an APPLIED row carries the claim STATEMENTS, and a declined row carries its code", () => {
    const rows: TailorChangeRowWithClaims[] = [
      {
        id: "chg-1",
        op: "rewrite_bullet",
        jsonPath: "work[0].highlights[0]",
        before: "Cut CI build time by 40%",
        after: "Reduced the CI build time by 40%",
        reason: "mirrors the JD's throughput requirement",
        targetRequirementIds: ["req-1"],
        sourceClaimIds: ["clm-1"],
        appliedBy: "tailoring_engine",
        accepted: true,
        sourceClaims: [
          {
            id: "clm-1",
            kind: "achievement",
            statement: "Cut the CI build time by 40% by caching the dependency layer",
            status: "user_confirmed",
            provenance: "document_import",
          },
        ],
      },
      {
        id: "chg-2",
        op: "rewrite_bullet",
        jsonPath: "work[0].highlights[1]",
        before: "Cut CI build time by 40%",
        after: null,
        reason: "FACT_DELTA: the proposed wording introduces a fact (metric:12000)",
        targetRequirementIds: [],
        sourceClaimIds: ["clm-1"],
        appliedBy: "tailoring_engine",
        accepted: false,
        sourceClaims: [],
      },
    ];
    const diff = diffRowsForChanges(rows);
    // SERVER ORDER, and nothing sorts it: the log is the order the user accepted them in.
    expect(diff.map((row) => row.key)).toEqual(["chg-1", "chg-2"]);
    expect(diff[0].sourceClaims[0]?.statement).toBe(
      "Cut the CI build time by 40% by caching the dependency layer",
    );
    expect(diff[1].rejectionCode).toBe("FACT_DELTA");
    expect(diff[1].after).toBeNull();
    expect(diff[1].accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. No score, and no document anywhere
// ---------------------------------------------------------------------------

describe("NO SCORE, EVER", () => {
  it("the pure model exports nothing whose name suggests a rating", () => {
    const source = readFileSync(path.join(HERE, "tailorModel.ts"), "utf8");
    const exported = [...source.matchAll(/export (?:function|const) (\w+)/g)].map((match) => match[1]);
    // The guard constant itself is exempt: naming the thing you forbid is not doing it.
    const rated = exported.filter((name) => name !== "SCORE_FUNCTIONS_ARE_FORBIDDEN");
    for (const name of rated) {
      for (const forbidden of SCORE_FUNCTIONS_ARE_FORBIDDEN) {
        expect(name.toLowerCase(), `${name} reads like a score`).not.toContain(forbidden);
      }
    }
  });
});

describe("the tailoring surface never renders a whole document", () => {
  it("the API module has no member whose name returns a document, and no `document` field", () => {
    // 06 sec.E.3: "The tailoring request never returns a whole rewritten document; it returns
    // ops only." Asserted on the SOURCE rather than on a rendered page, because the strongest
    // version of this is structural: there is nowhere to put a document.
    const source = readFileSync(path.join(HERE, "../../services/api/tailor.ts"), "utf8");
    const methods = [...source.matchAll(/^ {2}async (\w+)\(/gm)].map((match) => match[1]);
    expect(methods.sort()).toEqual(["apply", "listChanges", "propose"]);
    expect(/document\??\s*:/m.test(source.split("export const tailorApi")[1] ?? "")).toBe(false);
  });
});