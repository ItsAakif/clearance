import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, UserCog, Sparkles } from "lucide-react";
import { useCareerProfile, useUpsertProfile, useParseProfile } from "@/hooks/useJobs";
import type { CareerProfile } from "@/services/api";
import { useResumes } from "@/hooks/useResumeApi";

const SENIORITY = ['junior', 'mid', 'senior', 'staff', 'lead', 'principal'] as const;
const REQUIRED_FIELDS = ['targetRoles', 'seniority', 'topSkills'] as const;

function TagInput({
  value,
  onChange,
  placeholder,
  invalid,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {value.map((t) => (
          <Badge key={t} variant="secondary" className="gap-1">
            {t}
            <button
              type="button"
              className="ml-1 text-muted-foreground hover:text-foreground"
              onClick={() => onChange(value.filter((x) => x !== t))}
            >
              ×
            </button>
          </Badge>
        ))}
      </div>
      <Input
        className={invalid ? "border-destructive" : ""}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

export default function ProfilePage() {
  const navigate = useNavigate();
  const { data: existing, isLoading } = useCareerProfile();
  const upsert = useUpsertProfile();
  const parse = useParseProfile();
  const { data: resumes } = useResumes();

  const [form, setForm] = useState<Partial<CareerProfile>>({});
  const [missing, setMissing] = useState<string[]>([]);

  useEffect(() => {
    if (existing) setForm(existing);
  }, [existing]);

  const set = <K extends keyof CareerProfile>(key: K, val: CareerProfile[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const isComplete =
    Array.isArray(form.targetRoles) && form.targetRoles.length > 0 &&
    !!form.seniority &&
    Array.isArray(form.topSkills) && form.topSkills.length > 0;

  const completionPct = Math.round(
    (Number(Array.isArray(form.targetRoles) && form.targetRoles.length > 0) +
      Number(!!form.seniority) +
      Number(Array.isArray(form.topSkills) && form.topSkills.length > 0)) / 3 * 100
  );

  const handleSave = async () => {
    await upsert.mutateAsync(form);
  };

  const handleParse = async (resumeId: string) => {
    const r = await parse.mutateAsync(resumeId);
    setForm((f) => ({
      ...f,
      targetRoles: r.suggested.targetRoles || f.targetRoles,
      seniority: r.suggested.seniority || f.seniority,
      topSkills: r.suggested.topSkills || f.topSkills,
      industries: r.suggested.industries || f.industries,
      proofPoints: r.suggested.proofPoints || f.proofPoints,
      summary: r.suggested.summary || f.summary,
      parsedFromResumeId: resumeId,
    }));
    setMissing(r.missing);
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-card px-6 py-4">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <UserCog className="h-5 w-5" /> Career Profile
          </h1>
          <p className="text-sm text-muted-foreground">
            Tell us about your targets so we can score and tailor jobs to you
          </p>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl space-y-6 p-6">
            <Card className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium">Profile completeness</span>
                <span className="text-sm text-muted-foreground">{completionPct}%</span>
              </div>
              <Progress value={completionPct} />
              {!isComplete && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Required: Target Roles, Seniority, Top Skills. Missing fields are highlighted below.
                </p>
              )}
            </Card>

            {/* Auto-parse from resume */}
            <Card className="p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Auto-fill from resume</p>
                  <p className="text-xs text-muted-foreground">
                    We'll extract roles, skills, and summary with your LLM key. Salary/red flags still need you.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Select onValueChange={(v) => handleParse(v)}>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="Pick a resume" />
                    </SelectTrigger>
                    <SelectContent>
                      {resumes?.map((r: any) => (
                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {parse.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                </div>
              </div>
            </Card>

            <Card className="space-y-5 p-5">
              <div>
                <Label className="mb-1 flex items-center gap-2">
                  Target Roles {REQUIRED_FIELDS.includes('targetRoles') && !form.targetRoles?.length && (
                    <Badge variant="destructive">Required</Badge>
                  )}
                </Label>
                <TagInput
                  value={form.targetRoles || []}
                  onChange={(v) => set('targetRoles', v)}
                  placeholder="Add a role, e.g. Backend Engineer"
                  invalid={missing.includes('targetRoles')}
                />
              </div>

              <div>
                <Label className="mb-1 flex items-center gap-2">
                  Seniority {REQUIRED_FIELDS.includes('seniority') && !form.seniority && (
                    <Badge variant="destructive">Required</Badge>
                  )}
                </Label>
                <Select value={form.seniority || ""} onValueChange={(v) => set('seniority', v as CareerProfile['seniority'])}>
                  <SelectTrigger className={missing.includes('seniority') ? "border-destructive" : ""}>
                    <SelectValue placeholder="Select level" />
                  </SelectTrigger>
                  <SelectContent>
                    {SENIORITY.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <Label className="mb-1">Min Salary</Label>
                  <Input
                    type="number"
                    value={form.minSalary ?? ""}
                    onChange={(e) => set('minSalary', e.target.value ? Number(e.target.value) : undefined)}
                  />
                </div>
                <div>
                  <Label className="mb-1">Max Salary</Label>
                  <Input
                    type="number"
                    value={form.maxSalary ?? ""}
                    onChange={(e) => set('maxSalary', e.target.value ? Number(e.target.value) : undefined)}
                  />
                </div>
                <div>
                  <Label className="mb-1">Currency</Label>
                  <Input
                    value={form.currency ?? ""}
                    placeholder="USD"
                    onChange={(e) => set('currency', e.target.value)}
                  />
                </div>
              </div>

              <div>
                <Label className="mb-1">Location Preference</Label>
                <Input
                  value={form.locationPref ?? ""}
                  placeholder="e.g. Remote, NYC, Berlin"
                  onChange={(e) => set('locationPref', e.target.value)}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label className="mb-0.5">Remote only</Label>
                  <p className="text-xs text-muted-foreground">Filter out on-site roles</p>
                </div>
                <Switch
                  checked={form.remoteOnly ?? false}
                  onCheckedChange={(v) => set('remoteOnly', v)}
                />
              </div>

              <div>
                <Label className="mb-1 flex items-center gap-2">
                  Top Skills {REQUIRED_FIELDS.includes('topSkills') && !form.topSkills?.length && (
                    <Badge variant="destructive">Required</Badge>
                  )}
                </Label>
                <TagInput
                  value={form.topSkills || []}
                  onChange={(v) => set('topSkills', v)}
                  placeholder="Add a skill, e.g. TypeScript"
                  invalid={missing.includes('topSkills')}
                />
              </div>

              <div>
                <Label className="mb-1">Industries</Label>
                <TagInput
                  value={form.industries || []}
                  onChange={(v) => set('industries', v)}
                  placeholder="Add an industry"
                />
              </div>

              <div>
                <Label className="mb-1">Red Flags</Label>
                <TagInput
                  value={form.redFlags || []}
                  onChange={(v) => set('redFlags', v)}
                  placeholder="e.g. crypto, no equity, 6-day weeks"
                  invalid={missing.includes('redFlags')}
                />
              </div>

              <div>
                <Label className="mb-1">Proof Points</Label>
                <TagInput
                  value={form.proofPoints || []}
                  onChange={(v) => set('proofPoints', v)}
                  placeholder="e.g. Scaled API to 2M users"
                  invalid={missing.includes('proofPoints')}
                />
              </div>

              <div>
                <Label className="mb-1">Summary</Label>
                <Textarea
                  className="min-h-[100px]"
                  value={form.summary ?? ""}
                  placeholder="Short professional pitch"
                  onChange={(e) => set('summary', e.target.value)}
                />
              </div>
            </Card>

            {!isComplete && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                Profile is incomplete - evaluation and tailoring will work but with less personalization. Save anyway to keep your progress.
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => navigate('/app/jobs')}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={upsert.isPending}>
                {upsert.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                Save Profile
              </Button>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}