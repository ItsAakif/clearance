import { useLayoutEffect, useRef } from "react";
import { Ban, CheckCircle2, Circle, CircleMinus, KeyRound, Loader2, XCircle } from "lucide-react";
import type { BoardRunState, RunSnapshot } from "@/services/api/jobs";
import { getBoardKeyHint } from "@/features/jobs/boardKeyHints";
import {
  etaText,
  groupProgress,
  politenessNoticeText,
  rateText,
  registryProgressText,
  sweepRate,
} from "@/features/jobs/runProgress";
import type { SweepPoliteness, SweepSample } from "@/features/jobs/runProgress";

export interface BoardProgressListProps {
  snapshot?: RunSnapshot;
  pending: boolean;
  // Read-only display text for what is being searched (the base typed query).
  // Never mutated here and never fed back into filters or the search request.
  query?: string;
  // Live Full-sweep speed/ETA inputs (T911). Supplied ONLY by the live Full
  // mount while the batch loop is running; the settled (collapsed) view and
  // every non-Full mode omit it, so nothing here can change their output.
  // `processed` values are cumulative server positions, not deltas.
  sweep?: { samples: readonly SweepSample[]; total: number; politeness?: SweepPoliteness };
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ink-3" aria-label="running" />;
    case 'ok':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="done" />;
    case 'failed':
      return <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-label="failed" />;
    case 'needs_key':
      return <KeyRound className="h-4 w-4 shrink-0 text-warning" aria-label="needs API key" />;
    case 'cancelled':
      return <Ban className="h-4 w-4 shrink-0 text-ink-3" aria-label="cancelled" />;
    case 'pending':
      return <Circle className="h-4 w-4 shrink-0 text-ink-3" aria-label="pending" />;
    default:
      // Unrecognised status degrades gracefully: a neutral marker carrying the
      // raw status as its accessible name. The row also renders the raw status
      // text, so the UI never crashes and never renders blank.
      return <Circle className="h-4 w-4 shrink-0 text-ink-3" aria-label={status} />;
  }
}

// A unit counts as skipped when it carries a non-empty `skippedReason`,
// whatever its status - a group toggled off appears as skipped-with-reason,
// never as failed (mirrors the `groupProgress` counting rule).
function skippedReasonOf(board: BoardRunState): string | undefined {
  const reason = board.skippedReason;
  if (typeof reason === 'string' && reason.trim().length > 0) return reason.trim();
  return undefined;
}

// True when the snapshot carries any wave-7 additive field. Old snapshots
// (none of these fields) render exactly as before: the group-aware header
// segment and the per-row group/tier/skip/truncation affordances stay hidden.
function hasExtendedFields(snapshot: RunSnapshot): boolean {
  if (snapshot.mode !== undefined || snapshot.cancelled !== undefined) return true;
  return snapshot.boards.some(
    (b) =>
      b.tier !== undefined ||
      b.group !== undefined ||
      b.truncated !== undefined ||
      b.skippedReason !== undefined ||
      b.unitKind !== undefined,
  );
}

function BoardRow({ board }: { board: BoardRunState }) {
  // Specific key name per board type (hard scraper -> RapidAPI, medium
  // scraper -> Firecrawl/Crawl4AI/RapidAPI, aggregator -> provider key).
  // Falls back to the generic hint when the error is not key-related.
  const keyHint =
    board.status === 'needs_key'
      ? getBoardKeyHint({ type: board.type, name: board.name, error: board.error }) ??
        'needs an API key in Settings'
      : undefined;
  const skipped = skippedReasonOf(board);
  // Group/tier suffixes come from snapshot data only - no local group
  // vocabulary. Absent on old snapshots, so old rows render unchanged.
  const groupSuffix = board.group ? ` · ${board.group}` : '';
  const tierSuffix = board.tier !== undefined ? ` · tier ${board.tier}` : '';
  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      {skipped !== undefined ? (
        <CircleMinus className="h-4 w-4 shrink-0 text-ink-3" aria-label="skipped" />
      ) : (
        <StatusIcon status={board.status} />
      )}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {board.name}
        <span className="ml-2 font-normal text-ink-3">{board.type}{groupSuffix}{tierSuffix}</span>
      </span>
      {skipped !== undefined ? (
        <span
          className="max-w-[50%] shrink-0 truncate text-xs text-ink-3"
          title={skipped}
        >
          skipped — {skipped}
        </span>
      ) : board.status === 'ok' ? (
        <span className="shrink-0 text-xs text-ink-3">
          {board.resultCount} result{board.resultCount !== 1 ? 's' : ''}
          {board.truncated === true ? ' · results capped' : ''}
        </span>
      ) : board.status === 'failed' || board.status === 'needs_key' ? (
        <span
          className={`max-w-[50%] shrink-0 truncate text-xs ${
            board.status === 'needs_key' ? 'text-warning' : 'text-destructive'
          }`}
          title={board.error}
        >
          {board.status === 'needs_key'
            ? keyHint
            : board.error || 'failed'}
        </span>
      ) : board.status === 'cancelled' ? (
        <span className="shrink-0 text-xs text-ink-3">
          cancelled
        </span>
      ) : board.status === 'pending' || board.status === 'running' ? null : (
        <span
          className="max-w-[50%] shrink-0 truncate text-xs text-ink-3"
          title={board.status}
        >
          {board.status}
        </span>
      )}
    </li>
  );
}

export function BoardProgressList({ snapshot, pending, query, sweep }: BoardProgressListProps) {
  const scrollRef = useRef<HTMLUListElement>(null);
  const savedScroll = useRef(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop !== savedScroll.current) {
      el.scrollTop = savedScroll.current;
    }
  });

  // Snapshot unavailable (not yet arrived, or terminal-gone after a backend
  // restart / TTL expiry): degrade to text that keeps the what-is-being-
  // searched context instead of unmounting to a blank block.
  if (!snapshot) {
    const q = query?.trim();
    return (
      <div className="border-y border-rule py-2" aria-live="polite">
        <p className="truncate text-sm font-medium text-foreground" title={q || undefined}>
          {q ? `Searching for "${q}"...` : 'Starting search...'}
        </p>
        <p className="mt-1 text-xs text-ink-3">
          Board-level progress unavailable — results will appear below.
        </p>
      </div>
    );
  }
  // Grouping and done/total math come from the pure `groupProgress` helper
  // (T800) - no duplicated grouping logic here. For old snapshots its totals
  // match the pre-wave header math exactly (ok/failed/needs_key are done).
  const { groups, totals } = groupProgress(snapshot);
  const done = totals.done;
  const total = totals.total;
  const showGroups = hasExtendedFields(snapshot) && groups.length > 0;
  const registryProgress =
    snapshot.mode === 'full' ? registryProgressText(snapshot) : undefined;
  // T911: live Full-sweep speed / ETA / rate-limit note. Every string comes
  // from the pure `runProgress` helpers, and every one of them is gated on
  // `mode === 'full'` plus the presence of the `sweep` prop, so Standard/Deep
  // and the settled Full view render exactly as they did before. `rate` is
  // null during warm-up (< 2 samples 5 s apart), which suppresses both the
  // speed and the ETA rather than showing a guess.
  const liveSweep = snapshot.mode === 'full' ? sweep : undefined;
  const rate = liveSweep ? sweepRate(liveSweep.samples) : null;
  const lastSample = liveSweep && liveSweep.samples.length > 0
    ? liveSweep.samples[liveSweep.samples.length - 1]
    : undefined;
  const eta = liveSweep && lastSample
    ? etaText(lastSample.processed, liveSweep.total, rate)
    : null;
  const politenessNotice = liveSweep ? politenessNoticeText(liveSweep.politeness) : null;
  const q = query?.trim();
  return (
    <div className="border-y border-rule py-2" aria-live="polite">
      <p className="truncate text-sm font-medium text-foreground" title={q || undefined}>
        {q ? `Searching for "${q}": ${done} of ${total} boards done` : `Searching: ${done} of ${total} boards done`}
        {snapshot.cancelled === true && (
          <span className="ml-2 font-normal text-ink-3">
            cancelled
          </span>
        )}
        {registryProgress !== undefined && (
          <span className="ml-2 font-normal text-ink-3">
            {registryProgress}
          </span>
        )}
        {showGroups && (
          <span className="ml-2 font-normal text-ink-3">
            {groups.map((g) => `${g.group}: ${g.done} of ${g.total}`).join(' · ')}
            {totals.skipped > 0 && ` · ${totals.skipped} skipped`}
          </span>
        )}
        {!pending && (
          <span className="ml-2 font-normal text-ink-3">
            Total: {snapshot.totalListings} listings
          </span>
        )}
      </p>
      {snapshot.sweep !== undefined && (
        <p className="mt-1 text-xs text-ink-3 tabular-nums">
          Catalogue sweep: {snapshot.sweep.boards.toLocaleString('en-US')} boards,{' '}
          {snapshot.sweep.rowsPersisted.toLocaleString('en-US')} postings indexed
        </p>
      )}
      {(rate !== null || eta !== null) && (
        <div className="mt-1 text-xs text-ink-3">
          {[rate !== null ? rateText(rate) : null, eta].filter(Boolean).join(' · ')}
        </div>
      )}
      {politenessNotice !== null && (
        <p className="mt-1 text-xs text-warning" role="note">
          {politenessNotice}
        </p>
      )}
      <ul
        ref={scrollRef}
        role="list"
        aria-label="Board progress"
        tabIndex={0}
        onScroll={(e) => {
          savedScroll.current = e.currentTarget.scrollTop;
        }}
        className="mt-1 min-h-0 max-h-[40vh] overflow-y-auto overscroll-contain pr-1 divide-y divide-rule focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {snapshot.boards.map((board) => (
          <BoardRow key={board.boardId} board={board} />
        ))}
      </ul>
    </div>
  );
}
