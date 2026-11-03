// Diagnostics redaction - policy 9.4, implemented exactly as the document specifies it.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md sec. 9.3 and 9.4
// Task:         T1031
//
// WHAT THIS IS FOR. An engine's stdout/stderr is the single richest source of information
// about the image layout and about the user's own content, and policy 9.3 forbids it from
// reaching the API response outright. The server-side log may still carry it - that is the
// operator's only diagnostic - so 9.4 does not forbid diagnostics, it forbids UNREDACTED
// diagnostics: capture them, bound them, and redact them.
//
// THE ORDER IS THE REQUIREMENT, NOT A STYLE CHOICE (9.4 items 1-3, verbatim):
//
//   1. KNOWN CONSTANTS FIRST. `/work` -> `<workdir>`, `/out` -> `<out>`, the three
//      `/opt/typst*` mounts, `/tmp`, `$HOME`/`/nonexistent`, the redirected package cache.
//      A known location has to read as its own name; if the generic rule ran first, every
//      one of them would collapse to `<path>` and the operator would lose the one piece of
//      information that makes a diagnostic actionable. The table is applied LONGEST-FIRST
//      for the same reason at a smaller scale: `/opt/typst-packages` must not be eaten by
//      `/opt/typst`, and `/work/.pkgcache` must not be eaten by `/work`.
//
//   2. THEN EVERY ABSOLUTE-PATH-SHAPED TOKEN, whatever directory it names -> `<path>`.
//      This is the rule T1013 added and the reason it is stated by SHAPE rather than by
//      list: a blocklist of known host paths cannot be complete (the image layout is a
//      function of the pin, the vendored tree and the base image, all of which move), and
//      a template can write any path into its own diagnostic
//      (`#panic("... /etc/clearance-spike-canary.txt")`). A shape-based rule is total: one
//      regex, and a path the supervisor has never seen cannot defeat it.
//      Three shapes: a leading `/` with at least one further segment, a Windows drive
//      prefix (`C:\`, `C:/`), and a UNC prefix (`\\`).
//
//   3. THEN STAGED CONTENT -> `<content>`. Whatever bytes the job actually staged are
//      replaced, because a template that echoes its own input into a diagnostic would
//      otherwise put the user's resume text into a log. This runs LAST on purpose: content
//      substitution is the most expensive and the least specific rule, and running it first
//      would let content containing a path be re-classified as a path.
//
//   4. TRUNCATE TO 64 KiB. Last, so the bound applies to the REDACTED text - truncating
//      first would simply cut the record short and could leave a partial path in the
//      output.
//
// The function is applied to DIAGNOSTIC TEXT ONLY. It never touches artifact bytes (the
// broker redacts a log line, never a buffer it is about to return), and it never touches
// the user-facing message, which is a fixed string per outcome (policy 9.2) - see
// `OUTCOME_MESSAGES` in ./index.ts.

import { RENDER_PATHS } from '../sandbox.js';

/** The hard bound on what may reach the log for one job (policy 9.4). */
export const REDACT_MAX_BYTES = 64 * 1024;

/** What a known container location reads as, once substituted. */
export const REDACTED_LABELS = Object.freeze({
  workdir: '<workdir>',
  out: '<out>',
  packageCache: '<packageCache>',
  toolchain: '<toolchain>',
  packages: '<packages>',
  fonts: '<fonts>',
  tmp: '<tmpdir>',
  home: '<home>',
  /** The generic shape-based placeholder (9.4 item 1). */
  path: '<path>',
  /** The staged-content placeholder (9.4, third substitution). */
  content: '<content>',
});

/**
 * The known container constants, LONGEST FIRST.
 *
 * The order is load-bearing twice over. `/work/.pkgcache` before `/work`, and
 * `/opt/typst-packages`/`/opt/typst-fonts` before `/opt/typst`, or the shorter entry would
 * match the prefix of the longer one and leave `/packages` and `/fonts` dangling in the
 * log - a partial substitution that is worse than none, because it looks redacted.
 *
 * `$HOME` and `/nonexistent` are both here: the broker itself is a Node process with a
 * real `HOME`, and the container's policy `HOME` is the nonexistent path, so a diagnostic
 * that quotes either is disclosing layout.
 */
const KNOWN_CONSTANTS: ReadonlyArray<readonly [string, string]> = Object.freeze(
  (
    [
      [RENDER_PATHS.packageCache, REDACTED_LABELS.packageCache],
      [RENDER_PATHS.toolchain, REDACTED_LABELS.toolchain],
      [RENDER_PATHS.packages, REDACTED_LABELS.packages],
      [RENDER_PATHS.fonts, REDACTED_LABELS.fonts],
      [RENDER_PATHS.work, REDACTED_LABELS.workdir],
      [RENDER_PATHS.out, REDACTED_LABELS.out],
      ['/tmp', REDACTED_LABELS.tmp],
      ['$HOME', REDACTED_LABELS.home],
      ['/nonexistent', REDACTED_LABELS.home],
    ] as Array<[string, string]>
  ).sort((left, right) => right[0].length - left[0].length),
);

/**
 * One path segment. Whitespace, quotes, backticks, pipes and brackets terminate a path,
 * because a path never contains them in a way a reader would recognise as part of it;
 * stopping there is what keeps `error: /work/a.typ:3:5` from being read as one token.
 */
/**
 * One POSIX path segment: a run of characters that are not whitespace, a quote, a backtick,
 * a pipe or a bracket. A path never contains those in a way a reader would recognise as
 * part of it, and stopping there is what keeps `error: /work/a.typ:3:5` from being read as
 * one token.
 *
 * A BACKSLASH also terminates it, which is deliberate: a Windows path is matched by its own
 * rule, and letting a POSIX segment swallow a backslash would let `C:\x/y` be half-redacted.
 */
const SEGMENT = '[^\\s"\'`<>|()\\[\\]{},;]+';

/**
 * A Windows/UNC path BODY, where a backslash IS an ordinary separator. Zero-or-more, so
 * the quantifier lives inside the constant: appending one outside would produce `+*`, which
 * is a syntax error rather than a subtle bug - which is the outcome the test suite caught.
 */
const WINDOWS_BODY = '[^\\s"\'`<>|()\\[\\]{},;]*';

/** `/` plus AT LEAST ONE further segment. A bare `/` is punctuation, not a path. */
const POSIX_ABSOLUTE = new RegExp(`/(?:${SEGMENT}/)*${SEGMENT}/?`, 'g');
/** A Windows drive prefix: `C:\...` or `C:/...`. */
const DRIVE_ABSOLUTE = new RegExp(`[A-Za-z]:[\\\\/]${WINDOWS_BODY}`, 'g');
/** A UNC prefix: `\\server\share`. Checked before the POSIX rule by call order. */
const UNC_ABSOLUTE = new RegExp(`\\\\\\\\${WINDOWS_BODY}`, 'g');
/** Sentence punctuation a match may have swallowed, preserved so the log still reads. */
const TRAILING_PUNCTUATION = /[.,:;!?]+$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every absolute-path-SHAPED token with `<path>`.
 *
 * Three shapes, in the order 9.4 lists them. The trailing-punctuation capture means
 * `... at /etc/x.txt.` redacts to `... at <path>.` rather than swallowing the full stop,
 * so a sentence still reads as a sentence and a reviewer can tell a redaction from a
 * truncation.
 *
 * `\\` is handled first because `//server/share` and `\\server\share` both start with a
 * run of separators; a UNC match is the more informative reading and is applied first.
 */
export function redactPathShapes(text: string): string {
  return text
    .replace(UNC_ABSOLUTE, REDACTED_LABELS.path)
    .replace(DRIVE_ABSOLUTE, REDACTED_LABELS.path)
    .replace(POSIX_ABSOLUTE, (match) => {
      const punctuation = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
      const body = punctuation.length > 0 ? match.slice(0, match.length - punctuation.length) : match;
      // A `/` that turned out to be only punctuation (`//`, `/)`, `.:`) is not a path.
      if (body.length <= 1) return match;
      return `${REDACTED_LABELS.path}${punctuation}`;
    });
}

/**
 * Replace every occurrence of each staged blob with `<content>`.
 *
 * Only blobs long enough to be worth searching for are used: a one-byte staged file would
 * otherwise replace every occurrence of that byte throughout the diagnostic and turn a
 * readable log into a wall of `<content>`. The floor is 8 characters, which is below the
 * length of any realistic resume field and above the length of a byte that occurs by
 * chance everywhere. Longer blobs are substituted FIRST, so a blob that contains another
 * blob cannot leave a partially-substituted tail behind.
 *
 * Matching is literal (`split`/`join`, not a regex), so staged content is never treated as
 * a pattern - a `data.json` full of regex metacharacters cannot change the redaction's
 * behaviour, and a catastrophic-backtracking payload is not a denial-of-service surface.
 */
export function redactStagedContent(text: string, staged: readonly string[]): string {
  const usable = staged
    .filter((blob): blob is string => typeof blob === 'string' && blob.length >= 8)
    .sort((left, right) => right.length - left.length);
  let output = text;
  for (const blob of usable) {
    if (!output.includes(blob)) continue;
    output = output.split(blob).join(REDACTED_LABELS.content);
  }
  return output;
}

export interface RedactOptions {
  /**
   * The bytes this job staged, as UTF-8 text where they are text. Each is a candidate for
   * `<content>` substitution. Empty by default, which is the honest default for a job that
   * failed before staging.
   */
  readonly stagedContent?: readonly string[];
  /** Overridable so the 64 KiB bound is testable without a 64 KiB fixture. */
  readonly maxBytes?: number;
}

/**
 * The whole policy 9.4 pipeline, in the order the policy lists it.
 *
 * PURE and dependency-free apart from `RENDER_PATHS`: same input, same output, no clock,
 * no I/O, no environment. That is what lets `broker.test.ts` assert the canary fixture
 * byte for byte.
 *
 * The truncation is CHARACTER-based against a byte cap, which is the conservative reading:
 * a multi-byte character is never split, so the output is at most `maxBytes` BYTES even
 * when `maxBytes` is smaller than the code-point width - `Buffer.byteLength` on the
 * truncated string is what decides, and a further character is dropped rather than
 * half-written. A truncated record ends with an explicit marker, so an operator never
 * mistakes a clipped diagnostic for a complete one.
 */
export function redactDiagnostics(input: string, options: RedactOptions = {}): string {
  const maxBytes = options.maxBytes === undefined ? REDACT_MAX_BYTES : options.maxBytes;
  if (typeof input !== 'string' || input.length === 0) return '';
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('RENDER_POLICY_VIOLATION: the redaction bound must be a positive number');
  }

  // 1. Known constants first, so a known location reads as itself.
  let output = input;
  for (const [constant, label] of KNOWN_CONSTANTS) {
    if (constant.length === 0) continue;
    const pattern = new RegExp(escapeRegExp(constant), 'g');
    output = output.replace(pattern, label);
  }

  // 2. Then every absolute-path-SHAPED token, whatever it names.
  output = redactPathShapes(output);

  // 3. Then staged content.
  if (options.stagedContent !== undefined) {
    output = redactStagedContent(output, options.stagedContent);
  }

  // 4. Then the 64 KiB bound, measured in BYTES.
  if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;
  const marker = `...[truncated at ${maxBytes}B]`;
  let low = 0;
  let high = output.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(`${output.slice(0, mid)}${marker}`, 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${output.slice(0, low)}${marker}`;
}

/**
 * The assertion the tests use, and the one a reviewer should apply by hand: after
 * redaction, no `/`-prefixed, drive-prefixed or UNC-prefixed token survives, and no known
 * container constant survives.
 *
 * Exported (rather than only asserted inside `redactDiagnostics`) so the same predicate can
 * be applied to a string the test assembled by hand, which is how the "the broker never
 * named this path" half of the acceptance is proven: a canary at a path the broker has no
 * constant for still has to disappear, and the only mechanism that can do that is the
 * shape rule.
 */
export function assertNoPathShapedToken(text: string): void {
  const residue = redactPathShapes(text).match(/(?:^|[\s"'`(])(?:\/|[A-Za-z]:[\\/]|\\\\)/);
  if (residue !== null) {
    throw new Error('RENDER_POLICY_VIOLATION: a path-shaped token survived redaction');
  }
  for (const [constant] of KNOWN_CONSTANTS) {
    if (constant.length < 2) continue;
    if (text.includes(constant)) {
      throw new Error('RENDER_POLICY_VIOLATION: a known container constant survived redaction');
    }
  }
}
