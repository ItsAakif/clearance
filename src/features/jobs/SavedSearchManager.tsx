import { useState } from "react";
import { Card } from "@/components/ui/card";
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
import type { SavedSearch } from "@/services/api";

export function SavedSearchManager({
  onLoad,
}: {
  onLoad?: (s: SavedSearch) => void;
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

  const handleCreate = async () => {
    await createSearch.mutateAsync({ name, query, location: location || undefined, company: company || undefined });
    setOpen(false);
    setName("");
    setQuery("");
    setLocation("");
    setCompany("");
  };

  const handleRun = async (id: string) => {
    const results = await runSearch.mutateAsync(id);
    onLoad?.({} as SavedSearch);
    return results;
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="flex items-center gap-1 text-sm font-semibold">
            <Bookmark className="h-4 w-4" /> Saved Searches
          </h3>
          <p className="text-xs text-muted-foreground">Reuse filters across sessions</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus className="mr-1 h-4 w-4" /> New
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
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : searches && searches.length > 0 ? (
        <div className="space-y-2">
          {searches.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
              <div>
                <span className="font-medium">{s.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">{s.query}</span>
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
        <p className="py-4 text-center text-sm text-muted-foreground">No saved searches yet.</p>
      )}
    </Card>
  );
}