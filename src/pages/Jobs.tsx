import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Search, Loader2, Briefcase, ScanLine, UserCog, Target } from "lucide-react";
import { JobCard } from "@/features/jobs/JobCard";
import { BoardManager } from "@/features/jobs/BoardManager";
import { SavedSearchManager } from "@/features/jobs/SavedSearchManager";
import {
  useJobSearch, useBoards, useScanBoards, useCareerProfile,
} from "@/hooks/useJobs";
import type { JobListingSummary, SavedSearch } from "@/services/api";

const SOURCES = ['greenhouse', 'ashby', 'lever', 'workday', 'rss'] as const;

export default function JobsPage() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<string>("all");
  const [location, setLocation] = useState("");
  const [company, setCompany] = useState("");
  const [boardIds, setBoardIds] = useState<string[]>([]);
  const [results, setResults] = useState<JobListingSummary[]>([]);
  const navigate = useNavigate();
  const search = useJobSearch();
  const { data: boards } = useBoards();
  const scan = useScanBoards();
  const { data: profile } = useCareerProfile();

  const handleSearch = async () => {
    if (!query.trim()) return;
    const sources = source === 'all' ? undefined : [source];
    const qs = new URLSearchParams({ q: query.trim() });
    if (sources) qs.set('sources', sources.join(','));
    if (location) qs.set('location', location);
    if (company) qs.set('company', company);
    const data = await search.mutateAsync({ q: query.trim(), sources });
    setResults(data);
  };

  const handleScan = async () => {
    const data = await scan.mutateAsync({ query: query.trim() || undefined, boardIds });
    setResults(data);
  };

  const handleLoadSearch = (s: SavedSearch) => {
    setQuery(s.query);
    setLocation(s.location || "");
    setCompany(s.company || "");
    setBoardIds(s.boards || []);
  };

  const handleRunSearch = async (s: SavedSearch) => {
    handleLoadSearch(s);
    // saved-search run uses same scan pipeline; for simplicity reuse search with its query
    const data = await search.mutateAsync({ q: s.query });
    setResults(data);
  };

  const hasCompleteProfile = !!profile &&
    Array.isArray(profile.targetRoles) && profile.targetRoles.length > 0 &&
    !!profile.seniority &&
    Array.isArray(profile.topSkills) && profile.topSkills.length > 0;

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Job Search</h1>
            <p className="text-sm text-muted-foreground">
              Discover roles from public job boards, then evaluate & tailor
            </p>
          </div>
          <Button onClick={() => navigate('/app/match')}>
            <Target className="mr-2 h-4 w-4" /> Match jobs to your resume
          </Button>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-5xl space-y-6 p-6">
            {!hasCompleteProfile && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Complete your career profile for better matches & tailoring.
                </p>
                <Button size="sm" variant="outline" onClick={() => navigate('/app/profile')}>
                  <UserCog className="mr-1 h-4 w-4" /> Profile
                </Button>
              </div>
            )}

            <Card className="p-6">
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search roles, e.g. 'Senior React Engineer'"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  />
                </div>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger className="w-full sm:w-[160px]">
                    <SelectValue placeholder="Source" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {SOURCES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={handleSearch} disabled={search.isPending || !query.trim()}>
                  {search.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                  Search
                </Button>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  placeholder="Location filter (optional)"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
                <Input
                  placeholder="Company filter (optional)"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </div>
              {search.isError && (
                <p className="mt-3 text-sm text-destructive">Search failed. Check the backend job sources connection.</p>
              )}
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-1">
                <BoardManager />
                <SavedSearchManager onLoad={handleLoadSearch} />
              </div>

              <div className="lg:col-span-2">
                {boards && boards.length > 0 && (
                  <Card className="mb-4 p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <Label className="text-sm">Scan your boards</Label>
                      <Button size="sm" onClick={handleScan} disabled={scan.isPending}>
                        {scan.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanLine className="mr-2 h-4 w-4" />}
                        Scan my boards
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {boards.map((b) => (
                        <label key={b.id} className="flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs">
                          <input
                            type="checkbox"
                            checked={boardIds.includes(b.id)}
                            onChange={(e) =>
                              setBoardIds((prev) =>
                                e.target.checked ? [...prev, b.id] : prev.filter((x) => x !== b.id)
                              )
                            }
                          />
                          {b.name}
                        </label>
                      ))}
                    </div>
                  </Card>
                )}

                {results.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {results.map((job) => (
                      <JobCard key={job.id} job={job} onEvaluate={(j) => navigate(`/app/jobs/${j.id}`)} />
                    ))}
                  </div>
                ) : (
                  !search.isPending && !scan.isPending && (
                    <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                      <Briefcase className="mb-3 h-10 w-10 opacity-40" />
                      <p className="text-sm">Search public job boards or scan your configured boards to get started.</p>
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}