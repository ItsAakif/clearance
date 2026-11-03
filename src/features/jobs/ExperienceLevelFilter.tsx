// Experience-level multi-select (T222).
//
// Presentation only: a popover-backed button-list of the eight
// SENIORITY_LABELS rows that produces a deduped array of the six stored
// values via toggleSeniorityValue. No fetching, no filtering logic, no new
// dependencies.

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import {
  SENIORITY_LABELS,
  labelForValue,
  toggleSeniorityValue,
  type SeniorityValue,
} from "./seniority";

export interface ExperienceLevelFilterProps {
  value: SeniorityValue[];
  onChange: (next: SeniorityValue[]) => void;
  id?: string;
  compact?: boolean;
}

export function ExperienceLevelFilter({ value, onChange, id, compact }: ExperienceLevelFilterProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  const safe = Array.isArray(value) ? value : [];
  const triggerText =
    safe.length === 0
      ? "Any level"
      : safe.length === 1 && safe[0] !== undefined
        ? labelForValue(safe[0])
        : `${safe.length} levels`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          aria-label="Experience level"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          className="w-full justify-between"
        >
          <span className="truncate">{triggerText}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <div id={listId} role="listbox" aria-label="Experience level" className="max-h-72 overflow-auto">
          {SENIORITY_LABELS.map((row) => {
            const checked = safe.includes(row.value);
            const accessibleName = row.years ? `${row.label} (${row.years})` : row.label;
            return (
              <label
                key={row.key}
                className="flex cursor-pointer items-start gap-2 rounded-full p-1.5 text-xs hover:bg-paper-2"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(toggleSeniorityValue(safe, row.value, next === true))
                  }
                  aria-label={accessibleName}
                />
                <span>
                  <span className="block">{row.label}</span>
                  {!compact && row.years !== "" && (
                    <span className="block text-ink-3">{row.years}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-rule pt-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={safe.length === 0}
            onClick={() => onChange([])}
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
