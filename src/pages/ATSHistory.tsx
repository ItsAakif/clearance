import { useCallback, useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  FileText,
  ScanSearch,
  Trash2,
  ExternalLink,
  Calendar,
  Briefcase,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { AppLayout } from "@/components/layout";
import { atsApi, type SavedScanSummary } from "@/services/api/ats";
import { LLMEvaluationReport } from "@/features/ats-report";
import { useToast } from "@/hooks/use-toast";
import type { ATSReport } from "@/types/ats";

const getStatusColor = (status: SavedScanSummary["status"]) => {
  switch (status) {
    case "excellent":
      return "text-success";
    case "good":
      return "text-primary";
    case "needs-work":
      return "text-warning";
    default:
      return "text-destructive";
  }
};

const getStatusLabel = (status: SavedScanSummary["status"]) => {
  switch (status) {
    case "excellent":
      return "Excellent";
    case "good":
      return "Good";
    case "needs-work":
      return "Needs Work";
    default:
      return "Poor";
  }
};

const scoreColor = (score: number) =>
  score >= 80 ? "text-success" : score >= 60 ? "text-primary" : score >= 40 ? "text-warning" : "text-destructive";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ATSHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [scans, setScans] = useState<SavedScanSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ATSReport | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<SavedScanSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await atsApi.getSavedScans();
      setScans(data);
    } catch (error) {
      toast({
        title: "Could not load scans",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // Initial load
  useEffect(() => {
    load();
  }, [load]);

  const openScan = async (scan: SavedScanSummary) => {
    try {
      const full = await atsApi.getReport(scan.id);
      setSelected(full);
      setSelectedMeta(scan);
    } catch (error) {
      toast({
        title: "Could not open scan",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  if (selected && selectedMeta) {
    return (
      <AppLayout>
        <div className="flex h-full flex-col overflow-hidden">
          <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
            <div>
              <h1 className="text-lg font-semibold text-foreground">ATS Scan Report</h1>
              <p className="text-sm text-muted-foreground">
                {selectedMeta.fileName ? `${selectedMeta.fileName} · ` : ""}
                {formatDate(selectedMeta.createdAt)}
              </p>
            </div>
            <Button variant="ghost" onClick={() => {
              setSelected(null);
              setSelectedMeta(null);
            }}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to history
            </Button>
          </header>

          <div className="flex-1 overflow-auto">
            <div className="mx-auto max-w-5xl p-6">
              <div className="mb-6 flex items-center justify-between">
                <div className="text-right">
                  <div className={`text-3xl font-bold ${scoreColor(selected.overallScore)}`}>
                    {selected.overallScore}
                  </div>
                  <div className="text-xs text-muted-foreground">/ 100</div>
                </div>
              </div>

              {selected.scoredBy === "llm" && selected.evaluationJson ? (
                <LLMEvaluationReport evaluation={selected.evaluationJson} />
              ) : (
                <Card className="p-6">
                  <h3 className="mb-4 font-semibold">Scan Details</h3>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-semibold text-foreground">
                        {selected.categories.length}
                      </div>
                      <div className="text-xs text-muted-foreground">Categories</div>
                    </div>
                    <div>
                      <div className="text-2xl font-semibold text-foreground">
                        {selected.keywords.missing.length}
                      </div>
                      <div className="text-xs text-muted-foreground">Missing Keywords</div>
                    </div>
                    <div>
                      <div className="text-2xl font-semibold text-foreground">
                        {selected.formatting.issues.length}
                      </div>
                      <div className="text-xs text-muted-foreground">Formatting Issues</div>
                    </div>
                  </div>
                </Card>
              )}

              {selected.resumeId && (
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  <Button asChild>
                    <Link to={`/app/match?resumeId=${encodeURIComponent(selected.resumeId)}`}>
                      <Briefcase className="mr-2 h-4 w-4" /> Find matching jobs
                    </Link>
                  </Button>
                  <Button onClick={() => navigate(`/app/build/${selected.resumeId}`)}>
                    <ExternalLink className="mr-2 h-4 w-4" /> Open in Editor
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex h-full flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">ATS Scan History</h1>
            <p className="text-sm text-muted-foreground">
              All your saved ATS scans and scores
            </p>
          </div>
          <Button variant="outline" onClick={() => navigate("/app/ats-scan")}>
            <ScanSearch className="mr-2 h-4 w-4" /> New Scan
          </Button>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-5xl p-6">
            {loading ? (
              <Card className="p-10 text-center text-muted-foreground">Loading…</Card>
            ) : !scans || scans.length === 0 ? (
              <Card className="p-10 text-center">
                <FileText className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
                <p className="text-muted-foreground">No scans yet.</p>
                 <Button className="mt-4" onClick={() => navigate("/app/ats-scan")}>
                   Run your first ATS scan
                 </Button>
              </Card>
            ) : (
              <div className="space-y-3">
                {scans.map((scan) => (
                  <Card
                    key={scan.id}
                    className="flex cursor-pointer items-center justify-between p-4 transition-colors hover:bg-secondary/40"
                    onClick={() => openScan(scan)}
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-secondary text-xl font-bold ${scoreColor(
                          scan.overallScore
                        )}`}
                      >
                        {scan.overallScore}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {scan.fileName || (scan.isPublicScan ? "Public scan" : "Resume scan")}
                          </span>
                          <Badge variant="outline" className={getStatusColor(scan.status)}>
                            {getStatusLabel(scan.status)}
                          </Badge>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          {formatDate(scan.createdAt)}
                          {scan.scoredBy === "llm" && (
                            <Badge variant="secondary" className="ml-1">
                              AI
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
