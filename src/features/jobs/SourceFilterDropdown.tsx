// Sources filter popover (T912, spec D1-D3) - declutters the Jobs filter
// area. The seven source-group boxes and the per-board boxes used to wrap
// into two dense rows; they now live behind ONE "Sources" trigger.
//
// PRESENTATION ONLY (spec D2): the write path is unchanged. The parent
// passes `filters.sources` plus its own single write path
// (`JobFilters.updateSources`, which re-derives `filters.sourceGroups` via
// `selectedSourceGroups`), so every toggle below behaves exactly as the old
// inline rows did - a group unions its members in when any is missing and
// subtracts them all when fully covered; a board adds/removes one id. No
// local source/group list: groups and membership come from `./sourceGroups`
// and the board list from the generated contract
// `shared/job-sources.json` (the same list `JobFilters` maps over, which
// `Jobs.tsx` feeds from `jobSourcesContract.sources`).
//
// Structural precedent: `ExperienceLevelFilter` (outline Button trigger +
// ChevronDown, scrollable checkbox list, Clear/Done footer) - same Popover
// primitive, same footer shape, no new dependency.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import sourceContract from "../../../shared/job-sources.json";
import {
  BROWSER_GROUP,
  SOURCE_GROUPS,
  SOURCE_GROUP_MEMBERS,
  groupCheckState,
  toggleSourceGroup,
  type SourceGroup,
} from "./sourceGroups";

export interface SourceFilterDropdownProps {
  /** The selected source ids (`filters.sources`); empty means all boards. */
  sources: string[];
  /** The parent's single write path: `JobFilters.updateSources`. */
  onSourcesChange: (next: string[]) => void;
}

/** Every board id, in generated-contract order (the old inline row list). */
const CONTRACT_SOURCES: readonly string[] = sourceContract.sources;

export function SourceFilterDropdown({ sources, onSourcesChange }: SourceFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const safe = Array.isArray(sources) ? sources : [];

  // `toggleGroup` MOVED here from `JobFilters.tsx` (spec D2): the removed
  // group row was its only consumer, and the helper itself
  // (`groupCheckState` / `toggleSourceGroup`) stays in `./sourceGroups`,
  // where the parity tests pin it. Semantics byte-equivalent with the old
  // closure: union the members in when any is missing, subtract them all
  // once every member is selected.
  const toggleGroup = (group: SourceGroup) => {
    const members = SOURCE_GROUP_MEMBERS[group] ?? [];
    const allIn = members.length > 0 && members.every((id) => safe.includes(id));
    onSourcesChange(toggleSourceGroup(safe, members, !allIn));
  };

  // Board toggle: byte-equivalent with the old chip row - the checkbox's
  // `checked` argument decides add vs remove, nothing else.
  const toggleBoard = (id: string, checked: boolean | "indeterminate") => {
    onSourcesChange(checked ? [...safe, id] : safe.filter((x) => x !== id));
  };

  // D3 trigger summary. The total is the contract list length (27 today),
  // never a hardcoded number that could drift from the registry.
  const summary =
    safe.length === 0
      ? "All boards"
      : `${safe.length} of ${CONTRACT_SOURCES.length} boards`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Sources filter"
          aria-haspopup="dialog"
          aria-expanded={open}
          className="gap-2 text-xs"
        >
          <span className="truncate text-ink-3">Sources</span>
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="flex max-h-[min(calc(100vh-96px),max(var(--radix-popper-available-height),320px))] w-80 flex-col p-0"
      >
        {/* ONE scroll region (spec D1): the popup is bounded to the viewport, the
            groups + boards blocks share a single scroller, and the Clear/Done
            footer sits OUTSIDE it so it is always visible. The old fixed-height
            nested Boards scroller is gone - nesting is what left the group
            header clipped and the popup taller than its collision space. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <p className="px-1.5 pb-1 text-xs font-medium text-ink-3">
            Source groups
          </p>
          <div>
            {SOURCE_GROUPS.map((group) => {
              const members = SOURCE_GROUP_MEMBERS[group] ?? [];
              const isBrowser = group === BROWSER_GROUP;
              return (
                <label
                  key={group}
                  className="flex cursor-pointer items-center gap-1.5 text-xs"
                  title={
                    isBrowser
                      ? "Browser extraction is optional and deep-only: the toggle stays available, but a run without the browser tier reports it unavailable and proceeds."
                      : `Toggle every ${group} source at once`
                  }
                >
                  <Checkbox
                    checked={groupCheckState(safe, members)}
                    onCheckedChange={() => toggleGroup(group)}
                    aria-label={isBrowser ? "Source group browser (optional, deep only)" : `Source group ${group}`}
                  />
                  <span className="capitalize">{group}</span>
                  {isBrowser && (
                    <span className="text-ink-3">(optional, deep only)</span>
                  )}
                </label>
              );
            })}
          </div>

          <div className="my-1.5 border-t border-rule" />

          <p className="px-1.5 pb-1 text-xs font-medium text-ink-3">
            Boards
          </p>
          <div>
            {CONTRACT_SOURCES.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={safe.includes(s)}
                  onCheckedChange={(checked) => toggleBoard(s, checked)}
                  aria-label={`Filter source ${s}`}
                />
                <span className="capitalize">{s}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-rule p-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={safe.length === 0}
            onClick={() => onSourcesChange([])}
          >
            Clear
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
