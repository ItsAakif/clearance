import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  User,
  Mail,
  LogOut,
  Loader2,
  AlertCircle,
  MailWarning,
  ShieldCheck,
  KeyRound,
  Trash2,
  CheckCircle2,
  BookOpen,
} from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAuth, useDeleteAccount, useLogout, useResendVerificationEmail, useUpdateProfile } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from "@/hooks/useJobs";
import type { ApiKey } from "@/services/api";

// Setup Guide: which provider unlocks what, at what cost, step-by-step setup,
// and the exact key format expected. Ordered by how essential each is.
interface SetupProvider {
  name: string;
  tier: "Recommended" | "Optional";
  category: string;
  unlocks: string;
  cost: string;
  keyFormat: string;
  steps: string[];
  link: string;
  linkLabel: string;
}

const SETUP_PROVIDERS: SetupProvider[] = [
  {
    name: "Groq (LLM)",
    tier: "Recommended",
    category: "AI",
    unlocks: "AI job matching, resume tailoring, and evaluations.",
    cost: "Free tier (Llama models). No card needed.",
    keyFormat: "Paste the Groq API key (ggsk-…).",
    steps: [
      "Go to console.groq.com and create a free account.",
      "Open API Keys → Create Key.",
      "Copy the key (starts with ggsk-).",
      "In Clearance: API Keys → Add Key → Groq → paste it.",
    ],
    link: "https://console.groq.com/keys",
    linkLabel: "console.groq.com/keys",
  },
  {
    name: "Adzuna (Job Aggregator)",
    tier: "Recommended",
    category: "Job Boards",
    unlocks: "Global aggregated listings (LinkedIn/Indeed/ATS). Official API, 2,500 req/mo free.",
    cost: "Free tier: 2,500 req/mo (250/day). No card.",
    keyFormat: "Needs APP_ID + APP_KEY. Store as 'appId:appKey' in one key, or set ADZUNA_APP_ID / ADZUNA_APP_KEY env.",
    steps: [
      "Register a free developer app at developer.adzuna.com.",
      "Copy your Application ID and Application Key.",
      "Settings → API Keys → Add Key → Adzuna → paste 'appId:appKey' (colon-separated).",
      "Or set ADZUNA_APP_ID and ADZUNA_APP_KEY in backend .env.",
    ],
    link: "https://developer.adzuna.com/",
    linkLabel: "developer.adzuna.com",
  },
  {
    name: "Jooble (Job Aggregator)",
    tier: "Optional",
    category: "Job Boards",
    unlocks: "Global job listings via partner API. Good geographic coverage.",
    cost: "Free API key via partner portal.",
    keyFormat: "Paste the single Jooble API key.",
    steps: [
      "Request a free key at jooble.org/api/ (enter email, get key by email).",
      "Copy the API key.",
      "Settings → API Keys → Add Key → Jooble → paste it.",
    ],
    link: "https://jooble.org/api/",
    linkLabel: "jooble.org/api",
  },
  {
    name: "Careerjet (Job Aggregator)",
    tier: "Optional",
    category: "Job Boards",
    unlocks: "90+ country job search. Free affiliate API (requires an attribution link on results).",
    cost: "Free basic affiliate ID.",
    keyFormat: "Paste your Careerjet affiliate ID.",
    steps: [
      "Join the free partner program at careerjet.com/partners/.",
      "Copy your affiliate ID.",
      "Settings → API Keys → Add Key → Careerjet → paste the ID.",
      "Note: free tier requires showing a Careerjet attribution link.",
    ],
    link: "https://www.careerjet.com/partners/",
    linkLabel: "careerjet.com/partners",
  },
  {
    name: "Exa / Tavily (Search)",
    tier: "Optional",
    category: "Job Discovery",
    unlocks: "Web job-discovery queries. Skip if you only use ATS / aggregator boards.",
    cost: "Exa and Tavily both have free tiers.",
    keyFormat: "Paste the Exa or Tavily API key.",
    steps: [
      "Exa: exa.ai/dashboard/api-keys → create key. Tavily: tavily.com → account → API keys.",
      "Copy the key.",
      "Settings → API Keys → Add Key → Tavily (or Exa) → paste it.",
    ],
    link: "https://exa.ai/dashboard/api-keys",
    linkLabel: "exa.ai / tavily.com",
  },
  {
    name: "RapidAPI (JSearch + PullAPI)",
    tier: "Optional",
    category: "Job Boards",
    unlocks: "Hard anti-bot boards: LinkedIn, Indeed, ZipRecruiter, Glassdoor, Bayt. JSearch covers all in one call. Pat92 / Fantastic.Jobs are drop-in alternatives on the same key.",
    cost: "JSearch BASIC free (200 req/mo). No card. Paid tiers if you exceed it.",
    keyFormat: "Paste your RapidAPI app key (X-RapidAPI-Key).",
    steps: [
      "Create a free RapidAPI account (no card).",
      "Subscribe to JSearch BASIC ($0): rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch.",
      "Optional: also subscribe to linkedin-scraper-api6 and indeed-scraper-api2 (BASIC $0).",
      "Copy your RapidAPI key from My Apps.",
      "Settings → API Keys → Add Key → RapidAPI → paste it.",
    ],
    link: "https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/pricing",
    linkLabel: "rapidapi.com/jsearch",
  },
  {
    name: "Firecrawl / Crawl4AI (Scraping)",
    tier: "Optional",
    category: "Job Boards",
    unlocks: "Medium boards: Y Combinator, Wellfound, Instahyre, Sprout, Google. Crawl4AI can be self-hosted for free.",
    cost: "Firecrawl free tier; Crawl4AI free if self-hosted (Docker).",
    keyFormat: "Firecrawl: paste API key. Crawl4AI: paste key, set self-host URL in Label.",
    steps: [
      "Firecrawl: sign up at firecrawl.dev → copy API key. Crawl4AI: self-host via Docker (no key needed, set URL in Label).",
      "Settings → API Keys → Add Key → Firecrawl (or Crawl4AI) → paste key.",
      "For Crawl4AI self-host, put the base URL (e.g. http://localhost:3002/v2) in the Label field.",
    ],
    link: "https://www.firecrawl.dev/app/api-keys",
    linkLabel: "firecrawl.dev / crawl4ai",
  },
];

// Maps a BYOK provider key to its Setup Guide entry (for "View Setup" links).
const PROVIDER_SETUP_LINK: Record<string, string> = {
  groq: "https://console.groq.com/keys",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/keys",
  gemini: "https://aistudio.google.com/app/apikey",
  tavily: "https://tavily.com",
  adzuna: "https://developer.adzuna.com/",
  jooble: "https://jooble.org/api/",
  careerjet: "https://www.careerjet.com/partners/",
  firecrawl: "https://www.firecrawl.dev/app/api-keys",
  crawl4ai: "https://github.com/unclecode/crawl4ai",
  rapidapi: "https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/pricing",
};

// All configurable BYOK providers shown as rows. `important` marks the ones
// most users need (shown with a *). Users add only what they want.
const KEY_PROVIDERS: { provider: string; label: string; important: boolean }[] = [
  { provider: "groq", label: "Groq (LLM)", important: true },
  { provider: "openai", label: "OpenAI (LLM)", important: false },
  { provider: "openrouter", label: "OpenRouter (LLM)", important: false },
  { provider: "gemini", label: "Gemini (LLM)", important: false },
  { provider: "tavily", label: "Tavily (Search)", important: false },
  { provider: "adzuna", label: "Adzuna (Job Aggregator)", important: true },
  { provider: "jooble", label: "Jooble (Job Aggregator)", important: false },
  { provider: "careerjet", label: "Careerjet (Job Aggregator)", important: false },
  { provider: "firecrawl", label: "Firecrawl (Scraping)", important: false },
  { provider: "crawl4ai", label: "Crawl4AI (Scraping)", important: false },
  { provider: "rapidapi", label: "RapidAPI (Hard Boards)", important: true },
];

export default function SettingsPage() {
  const navigate = useNavigate();
  const { user, isLoading: authLoading } = useAuth();
  const logoutMutation = useLogout();
  const deleteAccountMutation = useDeleteAccount();
  const updateProfileMutation = useUpdateProfile();
  const resendVerificationMutation = useResendVerificationEmail();
  const { toast } = useToast();

  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editName, setEditName] = useState("");

  // BYOK (Bring Your Own Keys)
  const { data: apiKeys = [] } = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();
  // Per-provider input values for the "list of rows + Save All" form.
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);

  // Save every non-empty key input. Existing keys for that provider are kept;
  // new/changed values are created (backend stores per provider).
  const handleSaveAllKeys = async () => {
    const entries = Object.entries(keyInputs).filter(([, v]) => v.trim().length > 0);
    if (entries.length === 0) return;
    setSavingKeys(true);
    try {
      for (const [provider, apiKey] of entries) {
        const existing = (apiKeys as ApiKey[]).find((k) => k.provider === provider);
        // Skip if unchanged (compare against masked - only re-save if user typed a new full key)
        if (existing && existing.maskedKey && apiKey.trim() === existing.maskedKey) continue;
        await createKey.mutateAsync({ provider: provider as ApiKey["provider"], apiKey: apiKey.trim() });
      }
      setKeyInputs({});
      toast({ title: "Keys saved", description: "Your API keys were stored securely." });
    } catch (e: unknown) {
      toast({ title: "Some keys failed to save", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setSavingKeys(false);
    }
  };

  const handleLogout = async () => {
    await logoutMutation.mutateAsync();
    navigate("/");
  };

  const handleSaveProfile = async () => {
    if (!editName.trim()) return;
    await updateProfileMutation.mutateAsync({ name: editName });
    setIsEditingProfile(false);
  };

  const handleDeleteAccount = async () => {
    await deleteAccountMutation.mutateAsync();
    navigate("/");
  };

  const openEditProfile = () => {
    setEditName(user?.name || "");
    setIsEditingProfile(true);
  };

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        {/* Page header */}
        <header className="border-b border-border bg-card px-6 py-4">
          <h1 className="text-lg font-semibold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your account and API keys
          </p>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-2xl space-y-6 p-6">
            {/* Profile Card */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0 }}
            >
              <Card className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-foreground">Profile</h2>
                  <Button variant="ghost" size="sm" onClick={openEditProfile}>
                    Edit
                  </Button>
                </div>

                <div className="flex items-center gap-4">
                  {/* Avatar */}
                  <div className="relative">
                    {user?.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt={user.name || "Avatar"}
                        className="h-16 w-16 rounded-full object-cover ring-2 ring-primary/20"
                      />
                    ) : (
                      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/40 ring-2 ring-primary/20">
                        <User className="h-8 w-8 text-primary" />
                      </div>
                    )}
                  </div>

                  {/* User info */}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-foreground">
                        {user?.name || "No name set"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                      <Mail className="h-3.5 w-3.5" />
                      <span>{user?.email}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Member since {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "N/A"}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      {user?.emailVerified ? (
                        <Badge variant="secondary" className="gap-1 bg-success/10 text-success">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Email verified
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="gap-1 bg-warning/10 text-warning">
                          <MailWarning className="h-3.5 w-3.5" />
                          Verification pending
                        </Badge>
                      )}
                      {!user?.emailVerified && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => resendVerificationMutation.mutate()}
                          disabled={resendVerificationMutation.isPending}
                        >
                          {resendVerificationMutation.isPending ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          ) : null}
                          Resend verification email
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            </motion.div>

            {/* API Keys (BYOK) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
            >
              <Card className="p-6">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-5 w-5 text-muted-foreground" />
                    <h2 className="font-semibold text-foreground">API Keys (Bring Your Own)</h2>
                  </div>
                </div>

                <p className="mb-4 text-sm text-muted-foreground">
                  Add the keys you need - none are required to browse the built-in job boards. Keys are
                  encrypted and never shared. <span className="font-medium text-foreground">*</span> marks the
                  providers most users need.
                </p>

                <div className="space-y-3">
                  {KEY_PROVIDERS.map((row) => {
                    const existing = (apiKeys as ApiKey[]).find((k) => k.provider === row.provider);
                    return (
                      <div key={row.provider} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div className="min-w-0">
                          <label className="flex items-center gap-1 text-sm font-medium text-foreground">
                            {row.label}
                            {row.important && <span className="text-primary">*</span>}
                          </label>
                          <Input
                            type="password"
                            autoComplete="off"
                            value={keyInputs[row.provider] ?? ""}
                            onChange={(e) => setKeyInputs((prev) => ({ ...prev, [row.provider]: e.target.value }))}
                            placeholder={existing?.maskedKey ? `Saved: ${existing.maskedKey}` : "Paste key…"}
                            className="mt-1"
                          />
                        </div>
                        <a
                          href={PROVIDER_SETUP_LINK[row.provider]}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline whitespace-nowrap"
                        >
                          View Setup ↗
                        </a>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-5 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Saved keys: {apiKeys.length}
                  </p>
                  <Button onClick={handleSaveAllKeys} disabled={savingKeys || Object.values(keyInputs).every((v) => !v.trim())}>
                    {savingKeys ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                      </>
                    ) : (
                      "Save All Keys"
                    )}
                  </Button>
                </div>

                {apiKeys.length > 0 && (
                  <div className="mt-4 border-t border-border pt-4">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">Stored keys (remove any)</p>
                    <div className="space-y-2">
                      {apiKeys.map((k: ApiKey) => (
                        <div key={k.id} className="flex items-center justify-between rounded-lg border border-border p-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium capitalize text-foreground">{k.provider}</span>
                              {k.lastValidatedAt ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                              ) : (
                                <AlertCircle className="h-3.5 w-3.5 text-warning" />
                              )}
                            </div>
                            <p className="truncate text-xs text-muted-foreground">{k.maskedKey}</p>
                          </div>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => deleteKey.mutate(k.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            </motion.div>

            {/* Setup Guide (provider -> features -> cost -> link) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.22 }}
            >
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <BookOpen className="h-5 w-5 text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">Setup Guide</h2>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Clearance is self-hosted and bring-your-own-key (BYOK). Add only the providers for the
                  features you want - none are required to browse the built-in job boards. Click "Add Key"
                  in the API Keys card above to connect one.
                </p>
                <div className="space-y-3">
                  {SETUP_PROVIDERS.map((p) => (
                    <div key={p.name} className="rounded-lg border border-border p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{p.name}</span>
                            <Badge
                              variant="secondary"
                              className={p.tier === "Recommended" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}
                            >
                              {p.tier}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">{p.category}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{p.unlocks}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Cost:</span> {p.cost}
                          </p>
                        </div>
                        <a href={p.link} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">Setup ↗</Button>
                        </a>
                      </div>

                      <div className="mt-3 rounded-md bg-muted/40 p-3 text-xs">
                        <p className="font-medium text-foreground">Key format</p>
                        <p className="mt-0.5 text-muted-foreground">{p.keyFormat}</p>
                      </div>

                      <div className="mt-3">
                        <p className="mb-1.5 text-xs font-medium text-foreground">Setup steps</p>
                        <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                          {p.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  Note: Firecrawl/Crawl4AI and RapidAPI cover <span className="font-medium">different</span> boards.
                  For LinkedIn/Indeed/ZipRecruiter/Bayt use RapidAPI; for Y Combinator/Wellfound/Instahyre/Sprout/Google
                  use Firecrawl or Crawl4AI (Crawl4AI can be self-hosted for free). Adzuna/Careerjet/Jooble are official
                  aggregators that need no scraping and work alongside the above.
                </p>
              </Card>
            </motion.div>

            {/* Export Preferences */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <Card className="p-6">
                <h2 className="mb-4 font-semibold text-foreground">
                  Export Preferences
                </h2>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">Default Format</p>
                      <p className="text-sm text-muted-foreground">
                        PDF recommended for most applications
                      </p>
                    </div>
                    <Button variant="outline" size="sm">
                      PDF
                    </Button>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">Include Photo</p>
                      <p className="text-sm text-muted-foreground">
                        Add your photo to exported resumes
                      </p>
                    </div>
                    <Button variant="outline" size="sm">
                      Off
                    </Button>
                  </div>
                </div>
              </Card>
            </motion.div>

            {/* Account Actions */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <Card className="p-6">
                <h2 className="mb-4 font-semibold text-foreground">Account</h2>
                <div className="space-y-3">
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={handleLogout}
                    disabled={logoutMutation.isPending}
                  >
                    {logoutMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <LogOut className="mr-2 h-4 w-4" />
                    )}
                    Log Out
                  </Button>
                </div>
              </Card>
            </motion.div>

            {/* Danger Zone */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
            >
              <Card className="border-destructive/30 p-6">
                <h2 className="mb-4 font-semibold text-destructive">Danger Zone</h2>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-foreground">Delete Account</p>
                    <p className="text-sm text-muted-foreground">
                      Permanently delete your account and all data
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm">
                        Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This action cannot be undone. This will permanently delete your
                          account and remove all your data including resumes, job matches,
                          and settings.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={handleDeleteAccount}
                        >
                          Delete Account
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </Card>
            </motion.div>
          </div>
        </div>
      </div>

      {/* Edit Profile Dialog */}
      <Dialog open={isEditingProfile} onOpenChange={setIsEditingProfile}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Profile</DialogTitle>
            <DialogDescription>
              Update your profile information
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={user?.email || ""}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                Email cannot be changed
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditingProfile(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveProfile}
              disabled={updateProfileMutation.isPending || !editName.trim()}
            >
              {updateProfileMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </AppLayout>
  );
}
