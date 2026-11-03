// entityModel.test.ts - the entity mirror, the reorder rules and the honest empty states.
//
// THE MIRROR IS THE FIRST THING PROVEN. `entityModel.ts` restates the server's field lists and
// pairing table so a form can be built without a round trip. That is only safe while the two
// agree, so this file reads `backend/src/career/entities.ts` - the single authority - and
// asserts the agreement member by member and pairing by pairing. The technique is the one
// `features/studio/templateSwitch.test.ts` and `features/career/claimPresentation.test.ts`
// already use: a checked mirror instead of a second source of truth that nobody compares.
//
// Mutation (a) for this file: add a field to the backend's `ENTITY_FIELDS` (or a pairing to
// its `ENTITY_CLAIM_KINDS`) without adding it here, and "the mirror matches the server's own
// field lists, member for member" fails.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAREER_ENTITY_KINDS,
  ENTITY_CLAIM_KINDS,
  ENTITY_FIELDS,
  ENTITY_KIND_CLAIM_FIELD,
  buildEntityInput,
  canAttach,
  draftFromEntity,
  emptyDraft,
  emptyEntityState,
  entityDetail,
  entityKindsForClaimKind,
  entityListNote,
  entitySummary,
  isReorderable,
  missingRequiredFields,
  moveEntity,
  type CareerEntityKind,
  type EntityDraft,
} from "./entityModel";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");
const SERVER = readFileSync(path.join(REPO, "backend", "src", "career", "entities.ts"), "utf8");

/** The server's own per-kind block out of ONE of its two vocabulary tables. */
function serverBlock(table: "ENTITY_FIELDS" | "ENTITY_CLAIM_KINDS", kind: string): string {
  // Scoped to the table's own declaration: both tables spell their entries the same way, so a
  // search from the top of the file would read the fields when asked for the pairings.
  const tableStart = SERVER.indexOf(`export const ${table}`);
  expect(tableStart, `${table} is missing from the server source`).toBeGreaterThan(-1);
  const tableEnd = SERVER.indexOf("\nexport ", tableStart + 1);
  // Indentation-agnostic on purpose: `ENTITY_CLAIM_KINDS` sits at two spaces and
  // `ENTITY_FIELDS` at four, and a needle that only matched one of them would silently read the
  // wrong table.
  const start = SERVER.slice(tableStart).search(new RegExp(`^\\s+${kind}: Object\\.freeze\\(\\[`, "m"));
  expect(start, `${table}.${kind} is missing from the server source`).toBeGreaterThan(-1);
  const absolute = tableStart + start;
  expect(absolute, `${table}.${kind} leaked past the end of ${table}`).toBeLessThan(
    tableEnd === -1 ? SERVER.length : tableEnd,
  );
  const end = SERVER.indexOf("]),", absolute);
  expect(end, `${table}.${kind} is not terminated`).toBeGreaterThan(absolute);
  return SERVER.slice(absolute, end);
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

describe("the entity mirror matches the server's own tables", () => {
  it("offers exactly the server's six kinds, in the same order", () => {
    const serverOrder = [...SERVER.matchAll(/^\s+(\w+): Object\.freeze\(\[/gm)]
    .map((m) => m[1])
    // Each of the two tables lists the same six kinds, so the source order is that list twice.
    // Not `$`-anchored: a single-line entry (`education: Object.freeze([a, b]),`) has text
    // after the bracket, and an anchored pattern would silently drop it from the order.
    .slice(0, CAREER_ENTITY_KINDS.length);
    expect(serverOrder).toEqual([...CAREER_ENTITY_KINDS]);
  });

  it("matches the server's field lists, member for member", () => {
    for (const kind of CAREER_ENTITY_KINDS) {
      const block = serverBlock("ENTITY_FIELDS", kind);
      const serverFields = [...block.matchAll(/name: '(\w+)'/g)].map((m) => m[1]);
      expect(serverFields, kind).toEqual(ENTITY_FIELDS[kind].map((field) => field.name));
      // And the required flags agree, so a form cannot demand a field the server will not
      // take, or silently omit one it will.
      const serverRequired = [...block.matchAll(/name: '(\w+)', required: (true|false)/g)].map((m) => [
        m[1],
        m[2] === "true",
      ]);
      expect(serverRequired, kind).toEqual(
        ENTITY_FIELDS[kind].map((field) => [field.name, field.required]),
      );
    }
  });

  it("matches the server's pairing table, in order", () => {
    for (const kind of CAREER_ENTITY_KINDS) {
      const block = serverBlock("ENTITY_CLAIM_KINDS", kind);
      const serverPairs = [...block.matchAll(/ClaimKind\.(\w+)/g)].map((m) => m[1]);
      expect(serverPairs, kind).toEqual([...ENTITY_CLAIM_KINDS[kind]]);
    }
  });

  it("owns the same six claim-FK columns the server does", () => {
    for (const kind of CAREER_ENTITY_KINDS) {
      expect(ENTITY_KIND_CLAIM_FIELD[kind]).toBe(`${kind}Id`);
    }
    // `certification` is the one kind the schema gives no `sortOrder`, and the mirror says so
    // rather than offering an order control the server would refuse.
    expect(isReorderable("certification")).toBe(false);
    for (const kind of CAREER_ENTITY_KINDS.filter((k) => k !== "certification")) {
      expect(isReorderable(kind), kind).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The pairing, as the picker uses it
// ---------------------------------------------------------------------------

describe("which entries can a statement be filed under", () => {
  it("hides exactly the pairings the server refuses", () => {
    // The named example: an education statement cannot go under a project.
    expect(canAttach("education", "project")).toBe(false);
    expect(canAttach("project", "education")).toBe(false);
    expect(canAttach("role", "experience")).toBe(true);
    expect(canAttach("certification", "certification")).toBe(true);
    expect(canAttach("certification", "experience")).toBe(false);
  });

  it("gives an achievement three homes, and a certification exactly one", () => {
    expect(entityKindsForClaimKind("achievement")).toEqual(["experience", "project", "achievement"]);
    expect(entityKindsForClaimKind("certification")).toEqual(["certification"]);
  });

  it("never leaves a claim kind with nowhere to go", () => {
    const every = [
      "role",
      "responsibility",
      "achievement",
      "metric",
      "skill",
      "technology",
      "domain",
      "education",
      "certification",
      "project",
      "language",
      "soft_skill",
    ];
    for (const kind of every) {
      expect(entityKindsForClaimKind(kind), kind).not.toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

describe("a row says what the entry is, in one line", () => {
  it("names each kind by the members it actually has", () => {
    expect(entitySummary("experience", { title: "Senior Engineer", company: "Acme" })).toBe(
      "Senior Engineer - Acme",
    );
    expect(entitySummary("education", { degree: "BSc CS", institution: "UL" })).toBe("BSc CS - UL");
    expect(entitySummary("project", { name: "LedgerKit" })).toBe("LedgerKit");
    expect(entitySummary("skill", { name: "TypeScript" })).toBe("TypeScript");
    expect(entitySummary("certification", { name: "CKA", issuer: "CNCF" })).toBe("CKA - CNCF");
    expect(entitySummary("achievement", { statement: "Wrote the first algorithm" })).toBe(
      "Wrote the first algorithm",
    );
  });

  it("never renders a blank row, even for an empty record", () => {
    for (const kind of CAREER_ENTITY_KINDS) {
      expect(entitySummary(kind, {}).length, kind).toBeGreaterThan(0);
    }
  });

  it("says a current role has no end date, rather than printing an empty range", () => {
    expect(entityDetail("experience", { current: true, startDate: "2021-03" })).toBe("2021-03 - present");
    expect(entityDetail("experience", { current: false, startDate: "2018", endDate: "2021" })).toBe(
      "2018 - 2021",
    );
    expect(entityDetail("experience", { current: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

describe("reordering renumbers the list rather than swapping two entries", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves an entry up and issues one patch per entry", () => {
    const outcome = moveEntity("experience", rows, "c", "up");
    expect(outcome.moved).toBe(true);
    expect(outcome.ordered.map((row) => row.id)).toEqual(["a", "c", "b"]);
    expect(outcome.patches).toEqual([
      { id: "a", sortOrder: 0 },
      { id: "c", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });

  it("refuses a move past either end instead of wrapping", () => {
    expect(moveEntity("experience", rows, "a", "up").moved).toBe(false);
    expect(moveEntity("experience", rows, "c", "down").moved).toBe(false);
    expect(moveEntity("experience", rows, "nope", "up").moved).toBe(false);
  });

  it("does not pretend a certification can be ordered - the schema has no such column", () => {
    const outcome = moveEntity("certification", rows, "c", "up");
    expect(outcome.moved).toBe(false);
    expect(outcome.patches).toEqual([]);
    expect(outcome.ordered.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe("a draft becomes a request body with only the fields the kind has", () => {
  it("splits a tag list and drops an untouched optional field as null", () => {
    const draft = emptyDraft("project");
    expect(draft.tech).toBe("");
    const body = buildEntityInput("project", { ...draft, name: "LedgerKit", tech: "TypeScript, Postgres" });
    expect(body.name).toBe("LedgerKit");
    expect(body.tech).toEqual(["TypeScript", "Postgres"]);
    expect(body.role).toBeNull();
    // `sortOrder` is absent rather than `NaN` or "": an untouched integer sends nothing.
    expect("sortOrder" in body).toBe(false);
  });

  it("sends a parsed integer and drops a non-numeric one for the server to report", () => {
    const body = buildEntityInput("experience", { ...emptyDraft("experience"), title: "a", company: "b", sortOrder: "3" });
    expect(body.sortOrder).toBe(3);
    const bad = buildEntityInput("experience", { ...emptyDraft("experience"), title: "a", company: "b", sortOrder: "third" });
    expect("sortOrder" in bad).toBe(false);
  });

  it("carries a checkbox as a real boolean", () => {
    const body = buildEntityInput("experience", {
      ...emptyDraft("experience"),
      title: "Engineer",
      company: "Acme",
      current: true,
    });
    expect(body.current).toBe(true);
  });

  it("round-trips an existing row into an editable draft", () => {
    const draft = draftFromEntity("project", {
      id: "p1",
      name: "LedgerKit",
      tech: ["TypeScript", "Postgres"],
      role: null,
      description: "A reconciliation library",
    });
    expect(draft.name).toBe("LedgerKit");
    expect(draft.tech).toBe("TypeScript, Postgres");
    expect(draft.role).toBe("");
    // ...and back again, so "Edit, change one thing, Save" does not blank the rest.
    expect(buildEntityInput("project", { ...draft, name: "LedgerKit 2" }).name).toBe("LedgerKit 2");
    expect(buildEntityInput("project", draft).tech).toEqual(["TypeScript", "Postgres"]);
  });

  it("names the required fields a draft is still missing, for the Save button", () => {
    expect(missingRequiredFields("experience", emptyDraft("experience"))).toEqual(["Role", "Employer"]);
    const filled: EntityDraft = { ...emptyDraft("experience"), title: "Engineer", company: "Acme" };
    expect(missingRequiredFields("experience", filled)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

describe("the empty state says what is missing and what to do next", () => {
  it("distinguishes \"no entries and nothing to file\" from \"entries would do\"", () => {
    const nothing = emptyEntityState("experience", { hasStatements: false });
    expect(nothing).toMatch(/Import a resume or add a statement/);
    expect(nothing).toMatch(/built from both/);

    const something = emptyEntityState("experience", { hasStatements: true });
    expect(something).toMatch(/Add one, then file your existing statements/);
    expect(something).not.toMatch(/Import a resume/);
  });

  it("says plainly when nothing is placed on the page", () => {
    expect(entityListNote("role" as CareerEntityKind, 0)).toMatch(/places none of your statements/);
    expect(entityListNote("experience", 1)).toBe("1 statement filed under this role.");
    expect(entityListNote("experience", 3)).toBe("3 statements filed under these roles.");
  });
});

// ---------------------------------------------------------------------------
// The API wrapper, and the flag gate
// ---------------------------------------------------------------------------

describe("the entity client calls the entity endpoints, and offers no way to decide anything", () => {
  let calls: Array<{ url: string; method: string; body: unknown }> = [];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ kind: "experience", entities: [], entity: {}, detachedClaims: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads, creates, patches and deletes through the six-kind path", async () => {
    const { careerApi } = await import("@/services/api/career");
    await careerApi.listEntities("experience");
    await careerApi.createEntity("skill", { name: "TypeScript" });
    await careerApi.updateEntity("skill", "sk-1", { level: "expert" });
    await careerApi.deleteEntity("skill", "sk-1");
    expect(calls.map((call) => `${call.method} ${call.url.replace(/^.*\/api/, "")}`)).toEqual([
      "GET /career/entities/experience",
      "POST /career/entities/skill",
      "PATCH /career/entities/skill/sk-1",
      "DELETE /career/entities/skill/sk-1",
    ]);
    expect(calls[1].body).toEqual({ name: "TypeScript" });
  });

  it("attaches and detaches through the CLAIM paths, with a body that cannot carry a status", async () => {
    const { careerApi } = await import("@/services/api/career");
    await careerApi.attachClaim("clm-1", { kind: "experience", entityId: "exp-1" });
    await careerApi.detachClaim("clm-1", { kind: "experience", entityId: "exp-1" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toMatch(/\/career\/claims\/clm-1\/attach$/);
    expect(calls[0].body).toEqual({ kind: "experience", entityId: "exp-1" });
    expect(calls[1].url).toMatch(/\/career\/claims\/clm-1\/detach$/);

    // The types are the enforcement: `attachClaim` takes a kind and an entity id and has no
    // `status`, no `confirm` and no `note` member, so this client cannot write either.
    const source = readFileSync(path.join(REPO, "src", "services", "api", "career.ts"), "utf8");
    const attach = source.slice(source.indexOf("async attachClaim("), source.indexOf("async detachClaim("));
    for (const forbidden of ["status", "confirm"]) {
      expect(attach, `attachClaim must not offer '${forbidden}'`).not.toContain(forbidden);
    }
  });
});

describe("the entity UI is reachable only through the flag-gated page", () => {
  const SRC = path.join(REPO, "src");

  function filesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      // Toolchain scratch directories are skipped explicitly: the walk must report the
      // SOURCE TREE and nothing else, and a cache directory appearing mid-run would make this
      // assertion depend on when it ran.
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        return filesUnder(full);
      }
      return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [full] : [];
    });
  }

  // T1110 (cutover): the ROUTE-MEMBERSHIP half of this assertion is unchanged and still the
  // point - the entity surface lives behind `/app/profile` and gets no path of its own. The
  // GATE half is not: the page used to sit inside a `{flags.v2ResumeStudio ? (...) : null}`
  // conditional, and that conditional is gone. So the assertion is now that the route is
  // registered exactly once and unconditionally - which is a STRONGER claim about reachability
  // than "registered inside a conditional", because it means reachable in every build.
  it("no NEW route is registered: the surface is reachable only from /app/profile", () => {
    const app = readFileSync(path.join(SRC, "App.tsx"), "utf8");
    // No new path, and no new flag name.
    expect(app).not.toMatch(/entities/);
    expect(app.match(/path="\/app\/profile"/g)).toHaveLength(1);
    // Registered, and NOT inside the retired gate.
    expect(app).toMatch(/path="\/app\/profile"\s+element=\{<CareerProfile \/>\}/);
    expect(app).not.toMatch(/\{flags\.v2ResumeStudio \? \(/);
  });

  it("only the career page mounts the entity components", () => {
    const importers = filesUnder(SRC)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return /features\/career\/(EntityList|EntityClaimPicker|entityModel)/.test(source);
      })
      .map((file) => path.relative(REPO, file).replace(/\\/g, "/"));
    // One importer. `src/App.tsx` is not among them, so a flag-off build never renders any of
    // it - the page itself is simply not registered.
    expect(importers).toEqual(["src/pages/CareerProfile.tsx"]);
  });
});