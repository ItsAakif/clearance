// resume/legacyExportGuard.test.ts - the V2 cutover guard for the frozen export routes.
//
// WHAT IS PROVEN, and why it is worth a suite of its own rather than a line in the
// resumes test. The guard is a CORRECTNESS REFUSAL on a frozen surface, so its two
// halves are both load-bearing and each needs a positive control:
//
//   1. a V2 resume is refused, with a machine-readable reason that names the gated path;
//   2. a V1 resume is NOT refused - "exports exactly as before" is a claim, and a claim
//      with no control is an assumption.
//
// The route-level wiring (the guard is actually installed on all SIX legacy export /
// preview routes, and runs before any template, browser or buffer, and after the
// ownership check) is in `routes/resume.legacyExport.test.ts` and
// `routes/export.legacyExport.test.ts`. This file is the policy, tested exhaustively and
// without a database.

import { describe, it, expect } from 'vitest';
import {
  CLEARANCE_CONTROLLED_MODEL_VERSION,
  GATED_V2_RENDER_PATH,
  LEGACY_EXPORT_REFUSED_CODE,
  LEGACY_EXPORT_REFUSED_STATUS,
  isClearanceControlled,
  legacyExportRefusal,
  type LegacyExportResumeRef,
} from './legacyExportGuard.js';

const v1: LegacyExportResumeRef = { id: 'r1', userId: 'u1', modelVersion: 1 };
const v2: LegacyExportResumeRef = { id: 'r2', userId: 'u1', modelVersion: 2 };

describe('isClearanceControlled', () => {
  it('gates modelVersion >= 2 and leaves the legacy shape alone', () => {
    expect(CLEARANCE_CONTROLLED_MODEL_VERSION).toBe(2);
    // The legacy builder shape keeps working. This is the assertion the decision's
    // "a legacy resume still exports exactly as before" rests on, at the policy level.
    expect(isClearanceControlled(v1)).toBe(false);
    expect(isClearanceControlled(v2)).toBe(true);
  });

  it('gates a FUTURE model version too, rather than relaxing as the enum grows', () => {
    // A control that has to be re-decided deliberately is the correct default; a control
    // that silently stops applying at version 3 is not.
    expect(isClearanceControlled({ ...v2, modelVersion: 3 })).toBe(true);
    expect(isClearanceControlled({ ...v2, modelVersion: 99 })).toBe(true);
  });

  it('fails CLOSED on an absent row or an unreadable modelVersion', () => {
    // "I do not know what this is" must not resolve to "it is fine to render ungated".
    // The schema defaults `modelVersion` to 1, so a real row is never shape 0 - but a
    // partial select or a projection that drops the column must not become a bypass.
    expect(isClearanceControlled(null)).toBe(true);
    expect(isClearanceControlled(undefined)).toBe(true);
    expect(isClearanceControlled({ ...v1, modelVersion: NaN })).toBe(true);
    expect(isClearanceControlled({ ...v1, modelVersion: undefined as unknown as number })).toBe(true);
    expect(isClearanceControlled({ ...v1, modelVersion: '2' as unknown as number })).toBe(true);
  });
});

describe('legacyExportRefusal', () => {
  it('is machine-readable and points at the gated V2 path', () => {
    // The client needs three things and cannot get any of them from prose: a stable code
    // to branch on, a reason that says WHICH rule, and the path to use instead.
    const refusal = legacyExportRefusal(v2);
    expect(refusal.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(refusal.reason).toBe('V2_RESUME_NOT_EXPORTABLE_THROUGH_LEGACY_PATH');
    expect(refusal.gatedPath).toBe(GATED_V2_RENDER_PATH);
    expect(refusal.modelVersion).toBe(2);
    expect(refusal.error).toContain(GATED_V2_RENDER_PATH);
    // 409, not 404: the caller is authenticated and the resource exists. The refusal is a
    // rule, not a failed lookup.
    expect(LEGACY_EXPORT_REFUSED_STATUS).toBe(409);
  });

  it('interpolates nothing from the caller beyond the model version', () => {
    // A planted secret in the id / userId must not reach the body, or the refusal would
    // become an echo of whatever the caller sent.
    const refusal = legacyExportRefusal({
      id: 'SSN 123-45-6789',
      userId: 'admin@example.invalid',
      modelVersion: 2,
    });
    expect(refusal.error).not.toContain('SSN');
    expect(refusal.error).not.toContain('admin@');
    // ...and the shape is exactly the four documented members, so a new field cannot be
    // added by accident.
    expect(Object.keys(refusal).sort()).toEqual(['code', 'error', 'gatedPath', 'modelVersion', 'reason']);
  });
});
