// Ghost-job SIGNAL (evidence only). Computed at query time, never stored.

export type GhostLevel = 'clear' | 'watch';

export interface GhostSignal {
  level: GhostLevel;
  evidence: string[];
}

export interface GhostAggregate {
  repostCount: number;
  sourceCount: number;
  firstSeenAt: string | null;
  lastVerifiedAt: string | null;
  postedAt: string | null;
  isActive?: boolean;
}

export interface GhostRow {
  isActive?: boolean;
  postedAt?: string | null;
  firstSeenAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function daysAgo(now: Date, value: unknown): number | null {
  const date = asDate(value);
  if (!date) return null;
  return Math.floor((now.getTime() - date.getTime()) / DAY_MS);
}

interface Normalized {
  row: GhostRow;
  aggregate: GhostAggregate;
  now: Date;
}

function normalize(first: unknown, second?: unknown, third?: unknown): Normalized {
  let row: GhostRow = {};
  let aggregate: Partial<GhostAggregate> = {};
  let now: Date | undefined;

  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>;
    if ('row' in obj || 'aggregate' in obj || 'doc' in obj || 'listing' in obj) {
      row = (obj.row ?? obj.doc ?? obj.listing ?? {}) as GhostRow;
      aggregate = (obj.aggregate ?? {}) as Partial<GhostAggregate>;
      now = obj.now instanceof Date ? (obj.now as Date) : undefined;
      if (!now && second instanceof Date) now = second;
    } else if ('repostCount' in obj || 'sourceCount' in obj || 'lastVerifiedAt' in obj) {
      aggregate = obj as Partial<GhostAggregate>;
      row = obj as GhostRow;
      now = second instanceof Date ? second : (obj.now instanceof Date ? (obj.now as Date) : undefined);
    } else {
      row = obj as GhostRow;
      if (second && typeof second === 'object') {
        aggregate = second as Partial<GhostAggregate>;
      }
      now = third instanceof Date ? third : (second instanceof Date ? second : undefined);
    }
  }

  if (!now) now = new Date();

  const agg: GhostAggregate = {
    repostCount: Number.isFinite((aggregate as any).repostCount)
      ? Number((aggregate as any).repostCount)
      : 1,
    sourceCount: Number.isFinite((aggregate as any).sourceCount)
      ? Number((aggregate as any).sourceCount)
      : 1,
    firstSeenAt:
      (aggregate as any).firstSeenAt ?? (row as any).firstSeenAt ?? null,
    lastVerifiedAt: (aggregate as any).lastVerifiedAt ?? null,
    postedAt: (aggregate as any).postedAt ?? (row as any).postedAt ?? null,
    isActive: (aggregate as any).isActive ?? (row as any).isActive,
  };

  return { row, aggregate: agg, now };
}

export function computeGhost(first: unknown = {}, second?: unknown, third?: unknown): GhostSignal {
  const { row, aggregate, now } = normalize(first, second, third);

  const active = (row as any).isActive ?? aggregate.isActive ?? true;
  if (active !== true) {
    return { level: 'clear', evidence: [] };
  }

  const firstSeen = aggregate.firstSeenAt ?? (row as any).firstSeenAt ?? null;
  const posted = aggregate.postedAt ?? (row as any).postedAt ?? null;
  const lastVerified = aggregate.lastVerifiedAt ?? null;

  const firstAge = daysAgo(now, firstSeen);
  const postedAge = daysAgo(now, posted);

  const agedOut =
    firstAge !== null &&
    firstAge > 60 &&
    postedAge !== null &&
    postedAge > 60;

  const reposted =
    aggregate.repostCount >= 3 || aggregate.sourceCount >= 2;

  const watch = agedOut || reposted;

  if (!watch) {
    return { level: 'clear', evidence: [] };
  }

  const evidence: string[] = [];
  const push = (line: string): void => {
    if (!evidence.includes(line)) evidence.push(line);
  };

  if (agedOut) {
    if (firstAge !== null) push(`first seen ${firstAge} days ago`);
    if (postedAge !== null) push(`posted ${postedAge} days ago`);
  }

  if (reposted) {
    push(`reposted ${aggregate.repostCount} times across ${aggregate.sourceCount} sources`);
  }

  if (lastVerified !== null && lastVerified !== undefined) {
    const verifiedAge = daysAgo(now, lastVerified);
    if (verifiedAge !== null && verifiedAge > 14) {
      push(`not verified in ${verifiedAge} days`);
    }
  }

  return { level: 'watch', evidence };
}

export const computeGhostSignal = computeGhost;
export const deriveGhost = computeGhost;
export const ghost = computeGhost;
export const ghostSignal = computeGhost;
export const computeGhostJobSignal = computeGhost;

export default computeGhost;