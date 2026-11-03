import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Briefcase, Upload } from "lucide-react";
import { useCareerProfile, useUpsertProfile, useParseProfile, useUploadedFiles, useParseProfileFromUploadedFile, useUploadUploadedFile, useMergedLocationSuggestions } from "@/hooks/useJobs";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/layout/PageShell";
import { SectionView } from "@/components/layout/SectionView";
import { ProfileSectionTabs } from "@/components/layout/SectionTabs";
import type { CareerProfile } from "@/services/api";
import { useResumes } from "@/hooks/useResumeApi";
import { SENIORITY_LABELS, labelForValue } from "@/features/jobs/seniority";
import { LocationFilter } from "@/features/jobs/LocationFilter";
import { normalizeLocations } from "@/features/jobs/jobSearchUtils";

const REQUIRED_FIELDS = ['targetRoles', 'seniority', 'topSkills'] as const;

const REQUIRED_FIELD_LABELS: Record<(typeof REQUIRED_FIELDS)[number], string> = {
  targetRoles: 'Target Roles',
  seniority: 'Seniority',
  topSkills: 'Top Skills',
};

// The required-field count is driven only by targetRoles + seniority + topSkills.
// Every other field (salary, currency, location, skills extras, …) is optional
// and never blocks saving.
const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'INR', 'AED', 'SAR', 'CAD', 'AUD', 'SGD'] as const;

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
              className="ml-1 text-ink-3 hover:text-ink"
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
  const [searchParams] = useSearchParams();
  const { data: existing, isLoading } = useCareerProfile();
  const upsert = useUpsertProfile();
  const parse = useParseProfile();
  const parseUploaded = useParseProfileFromUploadedFile();
  const { data: resumes } = useResumes();
  const { data: uploadedFiles = [], isSuccess: uploadedFilesLoaded } = useUploadedFiles();
  const upload = useUploadUploadedFile();
  const { toast } = useToast();

  const [form, setForm] = useState<Partial<CareerProfile>>({});
  const [missing, setMissing] = useState<string[]>([]);
  // Currency picker: a Select of common codes plus a free-text fallback for
  // anything else. `currencyCustom` opens the text input; a stored value
  // outside the list also opens it (e.g. loaded from the server).
  const [currencyCustom, setCurrencyCustom] = useState(false);

  // Autofill source: builder resumes auto-parse on select; uploaded files need
  // an explicit confirm (no LLM call on mount or on selection).
  const [source, setSource] = useState<'resume' | 'uploaded'>('resume');
  const [pendingUploadedFileId, setPendingUploadedFileId] = useState('');
  const initializedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (existing) setForm(existing);
  }, [existing]);

  // Deep link: /app/profile?uploadedFileId=<id> preselects the uploaded source
  // and the file without parsing or toasting. Unknown ids leave the picker usable.
  useEffect(() => {
    if (initializedRef.current || !uploadedFilesLoaded) return;
    const id = searchParams.get('uploadedFileId');
    if (id && uploadedFiles.some((f) => f.id === id)) {
      setSource('uploaded');
      setPendingUploadedFileId(id);
    }
    initializedRef.current = true;
  }, [searchParams, uploadedFiles, uploadedFilesLoaded]);

  const set = <K extends keyof CareerProfile>(key: K, val: CareerProfile[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  // Location preference uses the shared Jobs city picker in multi-chip mode
  // (up to 10 chips, backend array contract per ADR-019). The chip array binds
  // directly to `locationPref` (StoredLocation): legacy plain strings decode to
  // one chip via normalizeLocations, JSON arrays preserve order, and empty
  // clears to undefined. Free text (e.g. "Remote") still commits as a chip;
  // the 80-char chip cap stays inside the backend limit. Engagement-gated like
  // Jobs: the city asset loads on first focus/keystroke, never on page mount.
  const [locationQuery, setLocationQuery] = useState('');
  const [locationEngaged, setLocationEngaged] = useState(false);
  const handleRequestLocationSuggestions = useCallback((q: string) => {
    setLocationQuery(q);
    setLocationEngaged(true);
  }, []);
  const { suggestions: locationSuggestions, isLoading: locationSuggestionsLoading } =
    useMergedLocationSuggestions(locationQuery, locationEngaged);
  const locationValue = normalizeLocations(form.locationPref);
  const handleLocationChange = (next: string[]) => {
    set('locationPref', next.length === 0 ? undefined : next);
  };

  const currencyIsCustom =
    !!form.currency && !(CURRENCY_CODES as readonly string[]).includes(form.currency);
  const showCurrencyInput = currencyCustom || currencyIsCustom;

  const requiredFieldSet: Record<(typeof REQUIRED_FIELDS)[number], boolean> = {
    targetRoles: Array.isArray(form.targetRoles) && form.targetRoles.length > 0,
    seniority: !!form.seniority,
    topSkills: Array.isArray(form.topSkills) && form.topSkills.length > 0,
  };
  const satisfiedRequiredFields = REQUIRED_FIELDS.filter((field) => requiredFieldSet[field]).length;
  const missingRequiredFields = REQUIRED_FIELDS.filter((field) => !requiredFieldSet[field]);
  const isComplete = missingRequiredFields.length === 0;

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

  const handleParseUploaded = async (fileId: string) => {
    const r = await parseUploaded.mutateAsync(fileId);
    // Never set parsedFromResumeId here: that field names a builder resume,
    // and an uploaded file must not be recorded as one (ADR-007).
    setForm((f) => ({
      ...f,
      targetRoles: r.suggested.targetRoles || f.targetRoles,
      seniority: r.suggested.seniority || f.seniority,
      topSkills: r.suggested.topSkills || f.topSkills,
      industries: r.suggested.industries || f.industries,
      proofPoints: r.suggested.proofPoints || f.proofPoints,
      summary: r.suggested.summary || f.summary,
    }));
    setMissing(r.missing);
  };

  // Direct resume upload from the empty state: the new file is selected in the
  // dropdown immediately (same invalidation + auto-select pattern as Match).
  const handleFileUpload = async (file: File) => {
    try {
      const created = await upload.mutateAsync(file);
      setPendingUploadedFileId(created.id);
      toast({ title: "Resume uploaded", description: `"${created.fileName}" is selected below.` });
    } catch {
      // Error toast is handled by the mutation.
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <PageShell
      title="Profile"
      width="prose"
      actions={
        <Button variant="outline" onClick={() => navigate('/app/jobs')} className="shrink-0">
          <Briefcase className="mr-2 h-4 w-4" />
          Discover jobs
        </Button>
      }
    >
      <ProfileSectionTabs />
      <SectionView
        title="Job preferences"
        description="Tell us about your targets so we can tailor jobs to you."
      />
      <div className="space-y-6">
            <section className="surface-card p-5">
              <h2 className="section-title">Required fields</h2>
              <div className="mt-2 border-t border-rule" />
              <p className="mt-3 text-sm text-ink">
                {satisfiedRequiredFields} of {REQUIRED_FIELDS.length} required fields set
              </p>
              {missingRequiredFields.length > 0 && (
                <p className="mt-1 text-xs2 text-ink-3">
                  Missing: {missingRequiredFields.map((field) => REQUIRED_FIELD_LABELS[field]).join(', ')}.
                  Each is marked Required below.
                </p>
              )}
            </section>

            {/* Auto-fill from resume or uploaded file */}
            <section className="surface-card p-5">
              <h2 className="section-title">Auto-fill from resume</h2>
              <div className="mt-2 border-t border-rule" />
              <div className="mt-3 flex flex-col gap-3">
                <p className="text-xs2 text-ink-3">
                  We'll extract roles, skills, and summary with your LLM key. Salary/red flags still need you.
                </p>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <Label>Source</Label>
                    <Select
                      value={source}
                      onValueChange={(v) => {
                        setSource(v as 'resume' | 'uploaded');
                        setPendingUploadedFileId('');
                      }}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="resume">From My Resumes</SelectItem>
                        <SelectItem value="uploaded">From an uploaded file</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {source === 'resume' ? (
                    <div className="flex items-center gap-2">
                      {resumes && resumes.length === 0 ? (
                        <p className="text-xs2 text-ink-3">
                          No builder resumes yet.
                        </p>
                      ) : (
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
                      )}
                      {parse.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    </div>
                  ) : (
                    <div className="flex flex-col items-start gap-2 sm:items-end">
                      {uploadedFiles.length > 0 ? (
                        <>
                          <div className="flex items-center gap-2">
                            <Select value={pendingUploadedFileId} onValueChange={(v) => setPendingUploadedFileId(v)}>
                              <SelectTrigger className="w-[200px]">
                                <SelectValue placeholder="Pick a file" />
                              </SelectTrigger>
                              <SelectContent>
                                {uploadedFiles.map((f) => (
                                  <SelectItem key={f.id} value={f.id}>{f.fileName}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {parseUploaded.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                          </div>
                          <p className="text-xs2 text-ink-3">
                            We read this file's extracted text and send it to your own LLM key.
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!pendingUploadedFileId || parseUploaded.isPending}
                            onClick={() => handleParseUploaded(pendingUploadedFileId)}
                          >
                            Autofill from this file
                          </Button>
                        </>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-xs2 text-ink-3">
                            No uploaded files yet - upload one here.
                          </p>
                          <Button
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={upload.isPending}
                          >
                            {upload.isPending ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Upload className="mr-2 h-4 w-4" />
                            )}
                            {upload.isPending ? "Uploading..." : "Upload resume"}
                          </Button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.doc,.docx,.txt"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void handleFileUpload(file);
                            }}
                          />
                          <Button variant="ghost" size="sm" onClick={() => navigate('/app/match')}>
                            Open Job Match
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="surface-card p-5">
              <h2 className="section-title">Targets</h2>
              <div className="mt-2 border-t border-rule" />
              <div className="mt-4 space-y-5">
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
                    {form.seniority ? labelForValue(form.seniority) : <SelectValue placeholder="Select level" />}
                  </SelectTrigger>
                  <SelectContent>
                    {SENIORITY_LABELS.map((row) => (
                      <SelectItem key={row.key} value={row.value}>
                        {row.years ? `${row.label} (${row.years})` : row.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label className="mb-1">Min Salary</Label>
                  <Input
                    type="number"
                    value={form.minSalary ?? ""}
                    onChange={(e) => set('minSalary', e.target.value ? Number(e.target.value) : undefined)}
                  />
                </div>
                <div>
                  <Label className="mb-1">Currency</Label>
                  <Select
                    value={showCurrencyInput ? "__custom" : (form.currency ?? "")}
                    onValueChange={(v) => {
                      if (v === "__custom") {
                        setCurrencyCustom(true);
                      } else {
                        setCurrencyCustom(false);
                        set('currency', v || undefined);
                      }
                    }}
                  >
                    <SelectTrigger>
                      {showCurrencyInput ? (
                        <span className="text-ink-3">Other (type below)</span>
                      ) : form.currency ? (
                        form.currency
                      ) : (
                        <SelectValue placeholder="Select currency" />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCY_CODES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                      <SelectItem value="__custom">Other (type below)</SelectItem>
                    </SelectContent>
                  </Select>
                  {showCurrencyInput && (
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        value={currencyIsCustom ? form.currency ?? "" : ""}
                        placeholder="Currency code, e.g. JPY"
                        maxLength={10}
                        onChange={(e) => set('currency', e.target.value || undefined)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          setCurrencyCustom(false);
                          if (currencyIsCustom) set('currency', undefined);
                        }}
                      >
                        Use list
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <Label htmlFor="profile-location" className="mb-1">Location Preference</Label>
                <LocationFilter
                  id="profile-location"
                  value={locationValue}
                  onChange={handleLocationChange}
                  suggestions={locationSuggestions}
                  suggestionsLoading={locationSuggestionsLoading}
                  onRequestSuggestions={handleRequestLocationSuggestions}
                  placeholder="e.g. Remote, NYC, Berlin"
                />
                <p className="mt-1 text-xs2 text-ink-3">
                  Add up to 10 locations. All listed locations are OR-matched.
                </p>
              </div>

              <div className="flex items-center justify-between border-b border-rule pb-3">
                <div>
                  <Label className="mb-0.5">Remote only</Label>
                  <p className="text-xs2 text-ink-3">Filter out on-site roles</p>
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
              </div>
            </section>

            {!isComplete && (
              <p className="border-t border-rule pt-3 text-sm text-ink-2">
                Profile is incomplete - evaluation and tailoring will work but with less personalization. Save anyway to keep your progress.
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => navigate('/app/jobs')}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={upsert.isPending}>
                {upsert.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Save profile
              </Button>
            </div>
      </div>
    </PageShell>
  );
}