// The LaTeX renderer: the serialiser's document in, a validated PDF artifact out.
//
// POLICY REVERSAL (owner decision, 2026-10-31): LaTeX was export-only (ADR-042 D1). It is
// now a SERVER-SIDE engine compiled through the same sandboxed render broker as Typst.
// This module is the LATEX half of the pipeline; `typst.ts` remains the Typst half and is
// unchanged in what it emits.
//
// WHAT IS DIFFERENT FROM TYPST
//   - the document is GENERATED per resume by `latexExport.ts` (the exporter's own bytes),
//     so it is staged as bytes, not copied from `template.tex`;
//   - the engine is `'latex'`, so the broker selects the LaTeX worker image and emits
//     `LATEX_POLICY`'s argv (the single argv builder in `sandbox.ts`);
//   - the template's pin is `engineVersionPins.latex`, against `LATEX_PIN.version`.
//
// WHAT IS IDENTICAL, DELIBERATELY
//   - in-memory staging (no host work dir), the JobSpec built from the staged tree's REAL
//     byte/file counts, the broker call, and the four re-checks on the received bytes
//     (`assertArtifactBytes`). A bad artifact cannot reach the store even as an orphan.
//   - the page count and digest helpers are the Typst ones, not a second implementation.

import {
  buildJobSpec,
  type RenderBrokerClient,
} from './brokerClient.js';
import { projectResumeDict, type ResumeDict } from './dict.js';
import { renderLatexExportBytes } from './latexExport.js';
import { LATEX_PIN, RENDER_LIMITS, buildCompileArgs, type CompilePlan } from './sandbox.js';
import { measureArchiveBytes, assertArtifactBytes, countPdfPages } from './typst.js';
import { stageRenderJobInMemory } from './stage.js';
import { storageKeyFor, type ArtifactStore } from './storage.js';
import { TEMPLATE_RESERVED_IDS, type TemplateRecord } from './templates.js';
import { RenderPortError, requestMimeType } from './types.js';

export interface LatexRenderInput {
  /** The immutable snapshot's document, projected through the ONE shared dictionary. */
  readonly resumeJson: unknown;
  /** The reviewed template record (`templates.ts`), already resolved by the port. */
  readonly record: TemplateRecord;
  /** Admission only. Never argv, never env, never a container name (ADR-044 D1). */
  readonly userId: string;
  readonly revisionId: string;
  readonly jobId: string;
  /** The revision's own creation time, epoch SECONDS. Never a clock read here. */
  readonly creationTimestampUnix: number;
  /** The revision's own `enginePins`, folded into the cache key by `renderPort.ts`. */
  readonly revisionPins: unknown;
  /** A pre-projected dictionary, when the caller already has one. Test seam + reuse. */
  readonly dict?: ResumeDict;
}

export interface LatexRenderOutput {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly engineVersion: string;
  readonly templateVersion: string;
  readonly storageKey: string;
  readonly pageCount: number | null;
  readonly durationMs: number;
  readonly nearLimit: {
    readonly inputBytes: number;
    readonly inputTotalBytes: number;
    readonly outputBytes: number;
  };
  readonly plan: CompilePlan;
}

export interface LatexRenderDeps {
  readonly broker: Pick<RenderBrokerClient, 'render'>;
  readonly artifacts: ArtifactStore;
  readonly now?: () => number;
}

/**
 * Stage the GENERATED LaTeX document, compile it through the broker, and re-validate what
 * came back.
 *
 * The order is the same as `renderTypstDocument`'s, for the same reasons:
 *   1. build the plan first, so a pin disagreement costs no I/O;
 *   2. serialise the dictionary with the exporter (one shared projection);
 *   3. stage in memory as `artifact.tex` (the engine's only allowed name);
 *   4. build the JobSpec from the tree's REAL archive length;
 *   5. render through the broker (admit, create, stage, compile, extract, validate,
 *      destroy);
 *   6. re-check size/digest/magic/cap before the caller can store a byte.
 */
export async function renderLatexDocument(
  deps: LatexRenderDeps,
  input: LatexRenderInput,
): Promise<LatexRenderOutput> {
  if (deps === null || typeof deps !== 'object' || deps.broker === undefined || deps.artifacts === undefined) {
    throw new TypeError('renderLatexDocument: a broker and an artifact store are required');
  }
  if (input === null || typeof input !== 'object') {
    throw new TypeError('renderLatexDocument: a render input is required');
  }
  if ((TEMPLATE_RESERVED_IDS as readonly string[]).includes(input.record.id)) {
    throw new TypeError('renderLatexDocument: a reserved template id cannot be rendered as a template');
  }

  // 1. The plan. Pure, no I/O: a pin disagreement costs nothing.
  const plan = buildCompileArgs('latex', {
    creationTimestampUnix: input.creationTimestampUnix,
    expectedEngineVersion: input.record.metadata.engineVersionPins.latex,
    format: 'pdf',
  });

  // 2. The ONE projection, then the exporter's own bytes. The layout variant is a property
  //    of the REVIEWED template record (`metadata.variant`), so a template cannot render in a
  //    layout its metadata does not name. `latexExport.ts` falls back to `ats-classic` for an
  //    absent or unknown value, which is the pre-variant output exactly.
  const dict = input.dict ?? projectResumeDict(input.resumeJson);
  const documentBytes = renderLatexExportBytes(dict, {
    variant: input.record.metadata.variant,
  });

  // 3. In-memory staging. `templateBytes` lands under the policy name `artifact.tex`,
  //    under the same caps as a file source.
  const tree = await stageRenderJobInMemory({
    engine: 'latex',
    templateBytes: documentBytes,
  });

  // 4. The JobSpec, with the tree's REAL numbers.
  const treeBytes = await measureArchiveBytes(tree);
  const spec = buildJobSpec({
    jobId: input.jobId,
    templateId: input.record.id,
    templateVersion: input.record.version,
    creationTimestampUnix: input.creationTimestampUnix,
    userId: input.userId,
    revisionId: input.revisionId,
    format: 'pdf',
    treeBytes,
    treeFileCount: tree.files.length,
    engine: 'latex',
  });
  if (spec.expectedEngineVersion !== plan.engineVersion) {
    throw new RenderPortError('RENDER_TOOLCHAIN_MISMATCH', 'PLAN_AND_SPEC_DISAGREE');
  }

  // 5. The broker.
  const started = deps.now === undefined ? Date.now() : deps.now();
  const result = await deps.broker.render(spec, tree);
  const durationMs = (deps.now === undefined ? Date.now() : deps.now()) - started;

  // 6. Re-validate the RECEIVED bytes before anything can store them.
  const mimeType = requestMimeType('pdf');
  assertArtifactBytes(result.artifact, result.byteSize, result.sha256, mimeType);

  return Object.freeze({
    bytes: result.artifact,
    sha256: result.sha256,
    byteSize: result.artifact.length,
    mimeType,
    engineVersion: LATEX_PIN.version,
    templateVersion: input.record.version,
    storageKey: storageKeyFor(result.sha256),
    pageCount: countPdfPages(result.artifact),
    durationMs,
    nearLimit: {
      inputBytes: tree.totalBytes,
      inputTotalBytes: RENDER_LIMITS.inputTotalBytes,
      outputBytes: result.artifact.length,
    },
    plan,
  });
}
