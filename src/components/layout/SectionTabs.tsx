import { useRef, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * One tab in a merged section. `active` is computed by the page from the current
 * pathname so a tab points at the canonical route it represents.
 */
export interface SectionTabItem {
  label: string;
  to: string;
  active: boolean;
}

export interface SectionTabsProps {
  items: SectionTabItem[];
  className?: string;
  "aria-label"?: string;
}

/**
 * The pill segmented control that sits at the top of a merged section.
 *
 * It is a real tablist: the active tab is the only one in the tab order, Left/Right
 * move focus between tabs, and Enter/Space opens the focused tab (via `navigate`,
 * because these are routes rather than in-place tab panels).
 */
export function SectionTabs({ items, className, "aria-label": ariaLabel }: SectionTabsProps) {
  const navigate = useNavigate();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusAt = (index: number) => {
    if (items.length === 0) return;
    const next = (index + items.length) % items.length;
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusAt(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusAt(index - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      navigate(items[index].to);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel ?? "Section"}
      className={cn("mb-6 inline-flex items-center gap-1", className)}
    >
      {items.map((item, index) => (
        <button
          key={item.to}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="tab"
          aria-selected={item.active}
          tabIndex={item.active ? 0 : -1}
          onClick={() => navigate(item.to)}
          onKeyDown={(event) => onKeyDown(event, index)}
          className={cn(
            "flex h-9 items-center rounded-full px-3 text-sm font-medium transition-colors duration-150 ease-out",
            item.active
              ? "bg-primary text-primary-foreground"
              : "text-ink-3 hover:bg-paper-2 hover:text-ink",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export default SectionTabs;

/** The section's own route is active only on its exact path. */
const exact = (pathname: string, to: string) => pathname === to;

/** A nested route (a resume id) keeps its tab active. */
const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(to + "/");

/** Resumes: Library | Studio. */
export function ResumeSectionTabs() {
  const { pathname } = useLocation();
  return (
    <SectionTabs
      aria-label="Resumes"
      items={[
        { label: "Library", to: "/app/resumes", active: exact(pathname, "/app/resumes") },
        { label: "Studio", to: "/app/studio", active: under(pathname, "/app/studio") },
      ]}
    />
  );
}

/** Profile: Career record | Job preferences. */
export function ProfileSectionTabs() {
  const { pathname } = useLocation();
  return (
    <SectionTabs
      aria-label="Profile"
      items={[
        { label: "Career record", to: "/app/profile", active: exact(pathname, "/app/profile") },
        {
          label: "Job preferences",
          to: "/app/profile/preferences",
          active: exact(pathname, "/app/profile/preferences"),
        },
      ]}
    />
  );
}

/** Match: Match | Tailor | Projects. */
export function MatchSectionTabs() {
  const { pathname } = useLocation();
  return (
    <SectionTabs
      aria-label="Match"
      items={[
        { label: "Match", to: "/app/match", active: exact(pathname, "/app/match") },
        {
          label: "Tailor",
          to: "/app/match/tailor",
          active: under(pathname, "/app/match/tailor"),
        },
        {
          label: "Projects",
          to: "/app/match/projects",
          active: exact(pathname, "/app/match/projects"),
        },
      ]}
    />
  );
}

/** Interview: Rehearsal | Prep | Question bank. */
export function InterviewSectionTabs() {
  const { pathname } = useLocation();
  return (
    <SectionTabs
      aria-label="Interview"
      items={[
        { label: "Rehearsal", to: "/app/interview", active: exact(pathname, "/app/interview") },
        {
          label: "Prep",
          to: "/app/interview/prep",
          active: under(pathname, "/app/interview/prep"),
        },
        {
          label: "Question bank",
          to: "/app/interview/questions",
          active: exact(pathname, "/app/interview/questions"),
        },
      ]}
    />
  );
}
