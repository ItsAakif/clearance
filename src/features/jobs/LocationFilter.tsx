import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { LocationSuggestion } from "@/services/api";
import { MAX_LOCATION_LENGTH, addLocation, removeLocation } from "./jobSearchUtils";
import { CITY_UI_LIMIT } from "./citySearch";

export interface LocationFilterProps {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: LocationSuggestion[];
  suggestionsLoading?: boolean;
  onRequestSuggestions?: (query: string) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}

/**
 * Controlled chip input for the location filter. Network-free: it never
 * fetches, it only reports typing upward through `onRequestSuggestions` and
 * renders whatever `suggestions` the caller provides. With an empty
 * `suggestions` array it behaves exactly like a plain chip input.
 */
export function LocationFilter({
  value,
  onChange,
  suggestions,
  suggestionsLoading,
  onRequestSuggestions,
  disabled,
  id,
  placeholder,
}: LocationFilterProps) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // No slicing here: the merged suggestion list already carries the pool cap,
  // and this component only limits the initially visible rows. The remainder
  // sits behind the show-more expander below.
  const rows = suggestions ?? [];
  const visibleRows = expanded ? rows : rows.slice(0, CITY_UI_LIMIT);
  const hiddenCount = rows.length - visibleRows.length;
  const open = focused && !dismissed && visibleRows.length > 0;
  const overLimit = draft.trim().length > MAX_LOCATION_LENGTH;
  const highlightValid = highlight >= 0 && highlight < visibleRows.length;

  // A new suggestion set can arrive while the input is focused (the async
  // answer to the focus/typing request). Drop any highlight that no longer
  // points at a row; the derived `open` flag picks the list up on its own.
  useEffect(() => {
    setHighlight((h) => (h >= 0 && h < visibleRows.length ? h : -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions, expanded]);

  const commitDraft = () => {
    if (!draft.trim()) {
      setDraft("");
      setDismissed(true);
      setHighlight(-1);
      setExpanded(false);
      return;
    }
    // Over-length drafts are kept for editing with the limit message shown;
    // addLocation would reject them, so never call onChange here.
    if (draft.trim().length > MAX_LOCATION_LENGTH) return;
    const next = addLocation(value, draft);
    if (next !== value) onChange(next);
    setDraft("");
    setDismissed(true);
    setHighlight(-1);
    setExpanded(false);
  };

  const selectSuggestion = (s: LocationSuggestion) => {
    const next = addLocation(value, s.value);
    if (next !== value) onChange(next);
    setDraft("");
    setDismissed(true);
    setHighlight(-1);
    setExpanded(false);
    inputRef.current?.focus();
  };

  const handleDraftChange = (raw: string) => {
    // Typing a comma commits everything before it as chips and keeps the
    // remainder as the draft, so "Berlin, London" needs no Enter per chip.
    if (raw.includes(",")) {
      const parts = raw.split(",");
      const rest = parts.pop() ?? "";
      let next = value;
      for (const part of parts) {
        const candidate = addLocation(next, part);
        if (candidate !== next) next = candidate;
      }
      if (next !== value) onChange(next);
      setDraft(rest);
      setDismissed(false);
      setHighlight(-1);
      setExpanded(false);
      onRequestSuggestions?.(rest);
      return;
    }
    setDraft(raw);
    setDismissed(false);
    setHighlight(-1);
    setExpanded(false);
    onRequestSuggestions?.(raw);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && visibleRows.length > 0) {
      e.preventDefault();
      setDismissed(false);
      setHighlight((h) => (h < 0 ? 0 : Math.min(h + 1, visibleRows.length - 1)));
    } else if (e.key === "ArrowUp" && visibleRows.length > 0) {
      e.preventDefault();
      setDismissed(false);
      setHighlight((h) => (h < 0 ? visibleRows.length - 1 : Math.max(h - 1, 0)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && highlightValid) {
        const picked = visibleRows[highlight];
        if (picked) selectSuggestion(picked);
      } else {
        commitDraft();
      }
    } else if (e.key === "Escape") {
      setDismissed(true);
      setHighlight(-1);
      setExpanded(false);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const hasCityRow = visibleRows.some((s) => s.source === 'city');

  return (
    <div className="relative">
      {value.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {value.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 text-xs text-ink-2">
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                className="text-ink-3 hover:text-ink"
                onClick={() => onChange(removeLocation(value, v))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        ref={inputRef}
        id={id}
        value={draft}
        placeholder={placeholder ?? "Location"}
        disabled={disabled}
        onChange={(e) => handleDraftChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
          onRequestSuggestions?.(draft);
        }}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
          setHighlight(-1);
          commitDraft();
        }}
        aria-label="Location filter"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Location suggestions"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-card border bg-popover p-1 text-popover-foreground shadow-e2"
          // Keep focus in the input so a row click never blurs through the
          // blur-commit path and adds the raw draft as a second chip.
          onMouseDown={(e) => e.preventDefault()}
        >
          {visibleRows.map((s, i) => (
            <div
              key={`${s.source}:${s.value}:${i}`}
              role="option"
              aria-selected={i === highlight}
              onClick={() => selectSuggestion(s)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 rounded-full px-2 py-1.5 text-sm",
                i === highlight ? "bg-paper-2" : "hover:bg-paper-2",
              )}
            >
              <span className="truncate">{s.display ?? s.value}</span>
              {s.count !== undefined && (
                <span className="shrink-0 text-xs text-ink-3">{s.count}</span>
              )}
            </div>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setExpanded(true);
                setHighlight(-1);
              }}
              className="w-full rounded-full px-2 py-1.5 text-left text-sm text-ink-3 hover:bg-paper-2 hover:text-foreground"
            >
              Show {hiddenCount} more...
            </button>
          )}
          {expanded && rows.length > CITY_UI_LIMIT && (
            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                setHighlight(-1);
              }}
              className="w-full rounded-full px-2 py-1.5 text-left text-sm text-ink-3 hover:bg-paper-2 hover:text-foreground"
            >
              Show less
            </button>
          )}
          {suggestionsLoading && (
            <div className="px-2 py-1.5 text-sm text-ink-3">Searching...</div>
          )}
          {hasCityRow && (
            <div className="px-2 pb-1 pt-2 text-xs text-ink-3">
              Cities: GeoNames (CC-BY)
            </div>
          )}
        </div>
      )}
      {overLimit && (
        <p className="mt-1 text-xs text-ink-3">
          Location is limited to {MAX_LOCATION_LENGTH} characters.
        </p>
      )}
    </div>
  );
}
