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
import { Trash2, Plus, Loader2 } from "lucide-react";
import { useBoards, useCreateBoard, useDeleteBoard } from "@/hooks/useJobs";
import type { JobBoard } from "@/services/api";
import { getBoardKeyHint } from "@/features/jobs/boardKeyHints";

const BOARD_TYPES = ['greenhouse', 'ashby', 'lever', 'workday', 'rss'] as const;

const DEPRECATED_AGGREGATOR_PROVIDERS = ['careerjet', 'jooble'];
const ACTIVE_AGGREGATOR_PROVIDERS = ['adzuna', 'usajobs', 'reed', 'findwork'];

export function BoardManager() {
  const { data: boards, isLoading } = useBoards();
  const createBoard = useCreateBoard();
  const deleteBoard = useDeleteBoard();

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<JobBoard['type']>('greenhouse');
  const [name, setName] = useState("");
  const [boardId, setBoardId] = useState("");
  const [feedUrl, setFeedUrl] = useState("");

  const handleCreate = async () => {
    await createBoard.mutateAsync({
      type,
      name: name || type,
      boardId: type === 'greenhouse' || type === 'ashby' || type === 'lever' ? boardId : undefined,
      feedUrl: type === 'rss' || type === 'workday' ? feedUrl : undefined,
    });
    setOpen(false);
    setName("");
    setBoardId("");
    setFeedUrl("");
  };

  const needsBoardId = type === 'greenhouse' || type === 'ashby' || type === 'lever';
  const needsFeedUrl = type === 'rss' || type === 'workday';

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Job Boards</h3>
          <p className="text-xs text-ink-3">Add the boards you want to scan</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Job Board</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="mb-1">Type</Label>
                <Select value={type} onValueChange={(v) => setType(v as JobBoard['type'])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BOARD_TYPES.map((t) => (
                      <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-1">Display Name</Label>
                <Input value={name} placeholder="e.g. My Greenhouse Board" onChange={(e) => setName(e.target.value)} />
              </div>
              {needsBoardId && (
                <div>
                  <Label className="mb-1">Company / Board Token</Label>
                  <Input value={boardId} placeholder="e.g. airbnb" onChange={(e) => setBoardId(e.target.value)} />
                </div>
              )}
              {needsFeedUrl && (
                <div>
                  <Label className="mb-1">Feed URL</Label>
                  <Input value={feedUrl} placeholder="https://.../jobs.rss" onChange={(e) => setFeedUrl(e.target.value)} />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                onClick={handleCreate}
                disabled={createBoard.isPending || (needsBoardId && !boardId) || (needsFeedUrl && !feedUrl)}
              >
                {createBoard.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Add Board
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading boards…
        </div>
      ) : boards && boards.length > 0 ? (
        <div className="space-y-2">
          {boards.map((b) => {
            // Missing-key failures name the exact key per board type (hard
            // scraper -> RapidAPI, medium scraper -> Firecrawl/Crawl4AI/
            // RapidAPI, aggregator -> provider key). Real failures keep the
            // generic "failing" badge with the full error in the tooltip.
            const keyHint = getBoardKeyHint({
              type: b.type,
              name: b.name,
              scraperProvider: b.scraperProvider,
              aggregatorProvider: b.aggregatorProvider,
              error: b.sourceHealth?.lastError,
            });
            return (
            <div key={b.id} className="flex items-center justify-between rounded-control border p-2 text-sm">
              <div>
                <span className="font-medium">{b.name}</span>
                <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs capitalize text-ink-3">{b.type}</span>
                {b.type === 'aggregator' && DEPRECATED_AGGREGATOR_PROVIDERS.includes(b.aggregatorProvider ?? '') && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-ink-3">Discontinued</span>
                )}
                {b.aggregatorProvider && <span className="ml-2 text-xs text-ink-3">{b.aggregatorProvider}</span>}
                {b.boardId && <span className="ml-2 text-xs text-ink-3">#{b.boardId}</span>}
                {b.sourceHealth?.status === 'failed' && (
                  <span
                    className="ml-2 text-xs text-destructive"
                    title={(b.sourceHealth.lastError ?? '').slice(0, 160)}
                  >
                    failing
                  </span>
                )}
                {keyHint && (
                  <span className="ml-2 text-xs text-warning">
                    {keyHint}
                  </span>
                )}
                {b.sourceHealth?.status === 'healthy' && b.sourceHealth.lastResultCount === 0 && (
                  <span className="ml-2 text-xs text-ink-3">0 results</span>
                )}
              </div>
              <Button size="icon" variant="ghost" onClick={() => deleteBoard.mutate(b.id)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
            );
          })}
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-ink-3">
          No boards yet. Add one to start scanning jobs.
        </p>
      )}
    </Card>
  );
}