// T783 snapshot tests - the run snapshot carries the evaluation summary
// additively (`evaluation: { requested, completed, skipped, reason?,
// estimate }`), written post-persist via the NEW `setRunEvaluation`.
//
// - older snapshots (no evaluation) still read back without the field;
// - unknown runIds are a no-op and never throw;
// - stored and returned summaries are defensive copies;
// - the six mutators keep their EXACT signatures (only the additive writer
//   and the optional field are new).
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  beginRun,
  getRun,
  resetRunsForTests,
  setRunEvaluation,
} from './discoveryRuns.js';

const HERE = __dirname;
const MODULE_PATH = path.join(HERE, 'discoveryRuns.ts');

beforeEach(() => {
  resetRunsForTests();
});

const SUMMARY = {
  requested: 5,
  completed: 4,
  skipped: 1,
  reason: 'rate_limited' as const,
  estimate: { calls: 5, approxTokens: 12345 },
};

describe('setRunEvaluation', () => {
  it('records the summary on a live run, readable via getRun', () => {
    beginRun('run-1', 'user-1', [{ id: 'b1', name: 'Board', type: 'json' }]);
    setRunEvaluation('run-1', SUMMARY);
    expect(getRun('run-1', 'user-1')?.evaluation).toEqual(SUMMARY);
  });

  it('is a no-op for unknown runIds and never throws', () => {
    expect(() => setRunEvaluation('no-such-run', SUMMARY)).not.toThrow();
  });

  it('stores and returns defensive copies (later mutation cannot rewrite the snapshot)', () => {
    beginRun('run-1', 'user-1', [{ id: 'b1', name: 'Board', type: 'json' }]);
    const input = { ...SUMMARY, estimate: { ...SUMMARY.estimate } };
    setRunEvaluation('run-1', input);
    input.requested = 999;
    input.estimate.calls = 999;
    expect(getRun('run-1', 'user-1')?.evaluation?.requested).toBe(5);
    expect(getRun('run-1', 'user-1')?.evaluation?.estimate.calls).toBe(5);
    const read = getRun('run-1', 'user-1')!;
    read.evaluation!.completed = 999;
    read.evaluation!.estimate.approxTokens = 999;
    expect(getRun('run-1', 'user-1')?.evaluation?.completed).toBe(4);
    expect(getRun('run-1', 'user-1')?.evaluation?.estimate.approxTokens).toBe(12345);
  });

  it('a summary without a reason round-trips without a reason key', () => {
    beginRun('run-1', 'user-1', [{ id: 'b1', name: 'Board', type: 'json' }]);
    setRunEvaluation('run-1', {
      requested: 0,
      completed: 0,
      skipped: 0,
      estimate: { calls: 0, approxTokens: 0 },
    });
    const read = getRun('run-1', 'user-1')?.evaluation;
    expect(read).toEqual({
      requested: 0,
      completed: 0,
      skipped: 0,
      estimate: { calls: 0, approxTokens: 0 },
    });
    expect('reason' in read!).toBe(false);
  });

  it('snapshots written before this wave read back with no evaluation field', () => {
    beginRun('run-1', 'user-1', [{ id: 'b1', name: 'Board', type: 'json' }]);
    expect(getRun('run-1', 'user-1')?.evaluation).toBeUndefined();
  });
});

describe('mutator signatures are unchanged (additive writer only)', () => {
  it('the six mutators keep their exact signatures', () => {
    const raw = readFileSync(MODULE_PATH, 'utf8');
    // The module uses CRLF line endings; normalise before matching so the
    // signature pin is about tokens, not line-ending style.
    const source = raw.replace(/\r\n/g, '\n');
    expect(source).toContain(
      'export function beginRun(\n  runId: string,\n  userId: string,\n  boards: BoardSeed[],\n  ttlMs: number = RUN_TTL_MS,\n): void {',
    );
    expect(source).toContain(
      'export function markRunning(runId: string, boardId: string): void {',
    );
    expect(source).toContain(
      'export function markOk(runId: string, boardId: string, resultCount: number, latencyMs: number): void {',
    );
    expect(source).toContain(
      'export function markFailed(runId: string, boardId: string, error: string, latencyMs: number): void {',
    );
    expect(source).toContain(
      'export function markNeedsKey(runId: string, boardId: string, reason: string): void {',
    );
    expect(source).toContain(
      'export function finishRun(runId: string, totalListings: number): void {',
    );
    expect(source).toContain(
      'export function setRunEvaluation(runId: string, summary: RunEvaluationSummary): void {',
    );
  });
});
