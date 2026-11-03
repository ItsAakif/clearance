import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2, Plus, Loader2, Bookmark } from "lucide-react";
import { useSavedSearches, useCreateSearch, useDeleteSearch, useRunSearch } from "@/hooks/useJobs";
import type { JobSearchFilters, SavedSearch } from "@/services/api";
// Wave 12 (T844, ADR-027): the save-current-search path captures the live
// filter state as an intent (pure helpers, tested in savedSearchIntent.test).
import {
  filtersToIntentInput,
  intentInputCarriesCriteria,
  summarizeSavedSearch,
} from "./savedSearchIntent";

export function SavedSearchManager({
  onLoad,
  currentFilters,
}: {
  onLoad?: (s: SavedSearch) => void;
  /**
   * The live filter state of the owning search page. When provided, a "save
   * current search" action captures it as an intent alongside the existing
   * manual create form. When absent the component behaves exactly as before.
   */
  currentFilters?: JobSearchFilters;
}) {
  const { data: searches, isLoading } = useSavedSearches();
  const createSearch = useCreateSearch();
  const deleteSearch = useDeleteSearch();
  const runSearch = useRunSearch();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [company, setCompany] = useState("");
  // Save-current-search name. The intent below is derived live from the
  // current filters on every render, so it can never go stale.
  const [saveName, setSaveName] = useState("");

  // The live filter state as an intent (undefined when the owner passes no
  // filters, hiding the save-current action entirely).
  const currentIntent = useMemo(
    () => (currentFilters ? filtersToIntentInput(currentFilters) : undefined),
    [currentFilters],
  );
  // The ONE no-criteria gate for the intent path (T842's rule, frontend
  // side): a name plus (query text or a criteria-bearing intent). The server
  // stays the authority (400); this is courtesy. The manual form below keeps
  // its original `!name || !query` gate untouched.
  const currentCarriesCriteria = currentIntent
    ? intentInputCarriesCriteria(currentIntent)
    : false;
  const canSaveCurrent =
    currentIntent !== undefined &&
    saveName.trim().length > 0 &&
    currentCarriesCriteria;

  const handleCreate = async () => {
    await createSearch.mutateAsync({ name, query, location: location || undefined, company: company || undefined });
    setOpen(false);
    setName("");
    setQuery("");
    setLocation("");
    setCompany("");
  };

  // Save-current-search: the current filters ride as an intent (the server
  // derives the legacy fields from it, so no query string is needed). The
  // existing free-text-only path above is untouched and still works.
  const handleSaveCurrent = async () => {
    if (!canSaveCurrent || !currentIntent) return;
    await createSearch.mutateAsync({ name: saveName.trim(), intent: currentIntent });
    setSaveName("");
  };

  const handleRun = async (id: string) => {
    const results = await runSearch.mutateAsync(id);
    onLoad?.({} as SavedSearch);
    return results;
  };

  return (
    <div>
      {/* Save-current-search: captures the live filter state as an intent.
          Rendered only when the owner passes its filters; the manual create
          form below is always available and unchanged. */}
      {currentIntent !== undefined && (
        <div className="mb-4 border-b border-rule pb-3">
          <Label className="mb-1">Save current search</Label>
          <div className="flex items-center gap-2">
            <Input
              value={saveName}
              placeholder="e.g. Senior backend, remote"
              onChange={(e) => setSaveName(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleSaveCurrent}
              disabled={createSearch.isPending || !canSaveCurrent}
            >
              {createSearch.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save current
            </Button>
          </div>
          {!currentCarriesCriteria && (
            <p className="mt-1 text-xs text-ink-3">
              Add a query or filter criteria to save the current search.
            </p>
          )}
        </div>
      )}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="section-label flex items-center gap-1">
            <Bookmark className="h-3.5 w-3.5" /> Saved searches
          </h3>
          <p className="mt-1 text-xs text-ink-3">Reuse filters across sessions</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus className="mr-1 h-4 w-4" /> New search
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Save Search</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="mb-1">Name</Label>
                <Input value={name} placeholder="e.g. Remote React roles" onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label className="mb-1">Query</Label>
                <Input value={query} placeholder="e.g. Senior Frontend" onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="mb-1">Location</Label>
                  <Input value={location} placeholder="optional" onChange={(e) => setLocation(e.target.value)} />
                </div>
                <div>
                  <Label className="mb-1">Company</Label>
                  <Input value={company} placeholder="optional" onChange={(e) => setCompany(e.target.value)} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createSearch.isPending || !name || !query}>
                {createSearch.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : searches && searches.length > 0 ? (
        <div className="space-y-2">
          {searches.map((s) => (
            <div key={s.id} className="flex items-center justify-between border-b border-rule py-2 text-sm">
              <div>
                <span className="font-medium">{s.name}</span>
                {/* Human summary derived from the intent (roles + mode +
                    groups); legacy rows without an intent fall back to the
                    stored query text. */}
                <span className="ml-2 text-xs text-ink-3">{summarizeSavedSearch(s)}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => onLoad?.(s)}>
                  Load
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleRun(s.id)} disabled={runSearch.isPending}>
                  Run
                </Button>
                <Button size="icon" variant="ghost" onClick={() => deleteSearch.mutate(s.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-ink-3">No saved searches yet.</p>
      )}
    </div>
  );
}