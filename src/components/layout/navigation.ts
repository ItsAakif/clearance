// App navigation - the SINGLE source of truth (ADR-004).
//
// INFORMATION ARCHITECTURE (the owner's merge). The sidebar is EIGHT entries, not thirteen:
// the pages that were separate destinations are now tabs inside the section they belong to.
// Every page still exists, every deep link still resolves, and the retired URLs redirect to
// their canonical path. The order below IS the sidebar order:
//
//   1. Resumes      /app/resumes   (tabs: Library | Studio)
//   2. Profile      /app/profile   (tabs: Career record | Job preferences)
//   3. Jobs         /app/jobs
//   4. Match        /app/match     (tabs: Match | Tailor | Projects)
//   5. Interview    /app/interview (tabs: Rehearsal | Prep | Question bank)
//   6. Applications /app/applications
//   7. Insights     /app/insights
//   8. Settings     /app/settings
//
// EVERY ENTRY CARRIES AN EXPLICIT `match` PREFIX LIST. A sidebar item stays active on the
// child routes that belong to it - Resumes on `/app/studio`, Profile on `/app/profile/*`,
// Match on `/app/match/*`, Interview on `/app/interview/*` - and `AppLayout` picks the
// LONGEST matching prefix, so a future nested destination cannot light up its parent by
// accident. The lists also name the retired prefixes (`/app/career`, `/app/tailor`,
// `/app/interview-prep`, `/app/qa-bank`) so a redirect in flight keeps the right item
// selected for the one render before the canonical URL is pushed.
//
// EVERY ENTRY HAS A LIVE ROUTE. `src/AppRouteTable.test.ts` resolves every href against the
// real route table in `src/App.tsx`, so an entry pointing at a retired path fails the build.

import {
  FolderOpen,
  Settings,
  Briefcase,
  KanbanSquare,
  UserCog,
  BarChart3,
  MessagesSquare,
  Target,
  type LucideIcon,
} from "lucide-react";

export type NavKind = "anchor" | "route";

export interface NavItem {
  label: string;
  href: string;
  icon?: LucideIcon;
  kind: NavKind;
}

/**
 * A sidebar entry: the base item plus the prefix list that decides when it is active.
 * `match` is explicit per entry rather than derived from `href`, because a section owns
 * paths that are not under its own URL (Resumes owns `/app/studio`).
 */
export interface AppNavItem extends NavItem {
  match: string[];
}

/**
 * The eight sidebar entries, in render order.
 *
 * The V1/V2 split is gone with the merge: one build, one list. The icons stay distinct so
 * the five sections are recognisable at a glance, not because the old destinations still
 * exist as sidebar entries.
 */
export const appNavItems: AppNavItem[] = [
  {
    label: "Resumes",
    href: "/app/resumes",
    match: ["/app/resumes", "/app/studio"],
    icon: FolderOpen,
    kind: "route",
  },
  {
    label: "Profile",
    href: "/app/profile",
    match: ["/app/profile", "/app/career"],
    icon: UserCog,
    kind: "route",
  },
  {
    label: "Jobs",
    href: "/app/jobs",
    match: ["/app/jobs"],
    icon: Briefcase,
    kind: "route",
  },
  {
    label: "Match",
    href: "/app/match",
    match: ["/app/match", "/app/tailor", "/app/project-discovery"],
    icon: Target,
    kind: "route",
  },
  {
    label: "Interview",
    href: "/app/interview",
    match: [
      "/app/interview",
      "/app/career-interview",
      "/app/interview-prep",
      "/app/qa-bank",
    ],
    icon: MessagesSquare,
    kind: "route",
  },
  {
    label: "Applications",
    href: "/app/applications",
    match: ["/app/applications"],
    icon: KanbanSquare,
    kind: "route",
  },
  {
    label: "Insights",
    href: "/app/insights",
    match: ["/app/insights"],
    icon: BarChart3,
    kind: "route",
  },
  {
    label: "Settings",
    href: "/app/settings",
    match: ["/app/settings"],
    icon: Settings,
    kind: "route",
  },
];

/**
 * The one list `AppLayout` renders. Kept as a function for the historical call site; there
 * is no flag to gate on and the returned array is the ordered list above.
 */
export function appNavItemsFor(..._gatedOnAFlagThatNoLongerExists: []): AppNavItem[] {
  return appNavItems;
}

/**
 * The active sidebar entry for a pathname, using the LONGEST matching prefix across every
 * item's `match` list. "Longest" is what makes `/app/applications/:id` resolve to
 * Applications (its only prefix) while a future `/app/applications/archive` entry could
 * take precedence over the parent without either item losing its own routes.
 */
export function activeNavItemFor(
  items: readonly AppNavItem[],
  pathname: string,
): AppNavItem | null {
  let best: AppNavItem | null = null;
  let bestLength = -1;
  for (const item of items) {
    for (const prefix of item.match) {
      const matches = pathname === prefix || pathname.startsWith(prefix + "/");
      if (matches && prefix.length > bestLength) {
        best = item;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** True when `pathname` belongs to `item`'s section, by any of its match prefixes. */
export function navItemIsActive(item: AppNavItem, pathname: string): boolean {
  return activeNavItemFor([item], pathname) !== null;
}

export const landingNavItems: NavItem[] = [
  { label: "Features", href: "/#features", kind: "anchor" },
  { label: "How it works", href: "/#how-it-works", kind: "anchor" },
  { label: "Self-hosting", href: "/#self-hosting", kind: "anchor" },
];
