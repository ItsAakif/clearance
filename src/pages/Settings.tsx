import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  LogOut,
  Loader2,
  AlertCircle,
  Trash2,
  CheckCircle2,
  Plus,
  MoreHorizontal,
  Upload,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageBody } from "@/components/layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLogout } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useApiKeys, useCreateApiKey, useDeleteApiKey } from "@/hooks/useJobs";
import type { ApiKey } from "@/services/api";
import {
  useModelSettings,
  useProviders,
  useProviderModels,
  useSetProviderModel,
  useUpdateModelSettings,
  mergePresetAndFetched,
  useCatalogueStatus,
  useImportCatalogueSnapshot,
  useSyncCatalogue,
} from "@/hooks/useSettings";
import type { ProviderPreset } from "@/services/api";

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
      "In Clearance: AI Providers → Add provider → Groq → paste it.",
    ],
    link: "https://console.groq.com/keys",
    linkLabel: "console.groq.com/keys",
  },
  {
    name: "Adzuna (Job Aggregator)",
    tier: "Recommended",
    category: "Job Boards",
    unlocks: "Global aggregated listings (LinkedIn/Indeed/ATS) - one of four aggregators. Official API, 2,500 req/mo free.",
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
    name: "USAJobs (Job Aggregator)",
    tier: "Recommended",
    category: "Job Boards",
    unlocks: "US federal openings (thousands of current announcements).",
    cost: "Fully free. No paid tier, no card.",
    keyFormat: "Needs your email + an API key. Store as 'email:apiKey' in one key, or set USAJOBS_EMAIL / USAJOBS_API_KEY env.",
    steps: [
      "Request a free API key at developer.usajobs.gov/apirequest/ (email form).",
      "Copy the key from the email.",
      "Settings → API Keys → Add Key → USAJobs → paste 'your@email:yourKey'.",
      "The email is sent as the required User-Agent header, so it must be the address you registered with.",
    ],
    link: "https://developer.usajobs.gov/apirequest/",
    linkLabel: "developer.usajobs.gov",
  },
  {
    name: "Reed (Job Aggregator)",
    tier: "Optional",
    category: "Job Boards",
    unlocks: "100,000+ UK vacancies.",
    cost: "Free API key. No card.",
    keyFormat: "Paste the single Reed API key (used as the Basic-auth username).",
    steps: [
      "Register at reed.co.uk/developers/jobseeker.",
      "Copy the API key (also shown as your API key on the Reed developer page).",
      "Settings → API Keys → Add Key → Reed → paste it.",
    ],
    link: "https://www.reed.co.uk/developers/jobseeker",
    linkLabel: "reed.co.uk/developers",
  },
  {
    name: "Findwork (Job Aggregator)",
    tier: "Optional",
    category: "Job Boards",
    unlocks: "Developer and design roles aggregated from HN, RemoteOK, We Work Remotely and Dribbble. Small but high-signal for engineering.",
    cost: "Free tier.",
    keyFormat: "Paste the single Findwork API token.",
    steps: [
      "Sign up at findwork.dev/developers/.",
      "Copy your API token from the developer page.",
      "Settings → API Keys → Add Key → Findwork → paste it.",
    ],
    link: "https://findwork.dev/developers/",
    linkLabel: "findwork.dev/developers",
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
      "Subscribe to JSearch BASIC ($0): https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch.",
      "Optional: also subscribe (BASIC $0) to https://rapidapi.com/pullapi-pullapi-default/api/linkedin-scraper-api6 and https://rapidapi.com/pullapi-pullapi-default/api/indeed-scraper-api2.",
      "In each listing's Code Snippet, check that X-RapidAPI-Host matches the listing you subscribed to (jsearch.p.rapidapi.com for canonical JSearch). If it shows a different jsearch host (e.g. jsearch-mega or a third-party fork), use that host's own endpoints instead.",
      "Clearance calls JSearch at GET /search-v2 (the current version's path).",
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
  exa: "https://exa.ai/dashboard/api-keys",
  adzuna: "https://developer.adzuna.com/",
  usajobs: "https://developer.usajobs.gov/apirequest/",
  reed: "https://www.reed.co.uk/developers/jobseeker",
  findwork: "https://findwork.dev/developers/",
  firecrawl: "https://www.firecrawl.dev/app/api-keys",
  crawl4ai: "https://github.com/unclecode/crawl4ai",
  rapidapi: "https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/pricing",
};

// Any stored key that is not an LLM provider id (13 registry ids or `custom:<slug>`) is
// shown here regardless of whether it has a KEY_PROVIDERS row. This is what guarantees a
// retired provider can never hide a user's key (see ADR-005).
const LLM_KEY_PROVIDER_IDS = [ 'groq','openai','openrouter','gemini','anthropic','zai',
  'deepseek','mistral','together','fireworks','azure-openai','ollama','lmstudio' ];

function isNonLlmKeyProvider(provider: string): boolean {
  return !provider.startsWith('custom:') && !LLM_KEY_PROVIDER_IDS.includes(provider);
}
function hasKeyProviderRow(provider: string): boolean {
  return KEY_PROVIDERS.some((r) => r.provider === provider);
}

// Non-LLM key rows (search / aggregators / scrapers). LLM providers moved to
// the unified "AI Providers" card below. `important` marks the ones most
// users need (shown with a *).
const KEY_PROVIDERS: { provider: string; label: string; important: boolean }[] = [
  { provider: "tavily", label: "Tavily (Search)", important: false },
  { provider: "exa", label: "Exa (Search)", important: false },
  { provider: "adzuna", label: "Adzuna (Job Aggregator)", important: true },
  { provider: "usajobs", label: "USAJobs (US Federal)", important: true },
  { provider: "reed", label: "Reed (UK)", important: false },
  { provider: "findwork", label: "Findwork (Dev & Design)", important: false },
  { provider: "firecrawl", label: "Firecrawl (Scraping)", important: false },
  { provider: "crawl4ai", label: "Crawl4AI (Scraping)", important: false },
  { provider: "rapidapi", label: "RapidAPI (Hard Boards)", important: true },
];

// ==================== AI PROVIDERS (unified picker) ====================
// Kilo-style flow: configured-provider rows → "Add provider" (searchable,
// grouped dialog) → key entry → model picker (fetched list merged
// presets-first, manual input fallback).

function prettifySlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Providers whose key must be stored together with an endpoint URL. */
function needsEndpoint(providerId: string): boolean {
  return providerId === "azure-openai" || providerId === "custom:new" || providerId.startsWith("custom:");
}

interface KeyTarget {
  /** Preset id, existing `custom:<slug>`, or `"custom:new"`. */
  providerId: string;
  preset?: ProviderPreset;
  isChange: boolean;
}

interface ModelTarget {
  providerId: string;
  preset: ProviderPreset;
  /** Just-saved key, so the first model fetch works before a refetch. */
  pendingKey?: string;
}

function AiProvidersCard() {
  const { toast } = useToast();
  const { data: apiKeys = [] } = useApiKeys();
  const createKey = useCreateApiKey();
  const deleteKey = useDeleteApiKey();
  const { data: providers = [], isLoading: providersLoading } = useProviders();
  const { data: modelSettings } = useModelSettings();
  const setModel = useSetProviderModel();
  const updateModels = useUpdateModelSettings();

  const [addOpen, setAddOpen] = useState(false);
  const [keyTarget, setKeyTarget] = useState<KeyTarget | null>(null);
  const [modelTarget, setModelTarget] = useState<ModelTarget | null>(null);

  // Key dialog fields
  const [keyInput, setKeyInput] = useState("");
  const [endpointInput, setEndpointInput] = useState("");
  const [customNameInput, setCustomNameInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  // Model dialog manual fallback
  const [manualModel, setManualModel] = useState("");
  useEffect(() => {
    setManualModel("");
  }, [modelTarget?.providerId]);

  // Custom providers known only via stored keys (backend has no preset).
  const allProviders: ProviderPreset[] = useMemo(() => {
    const known = new Set(providers.map((p) => p.id));
    const customs: ProviderPreset[] = [];
    for (const k of apiKeys as ApiKey[]) {
      if (k.provider.startsWith("custom:") && !known.has(k.provider)) {
        known.add(k.provider);
        customs.push({
          id: k.provider,
          label: prettifySlug(k.provider.slice("custom:".length)),
          baseUrl: "",
          keyPrefix: null,
          authStyle: "bearer",
          protocol: "openai",
          defaultModel: "",
          presetModels: [],
          fetchModels: true,
          group: "other",
        });
      }
    }
    return [...providers, ...customs];
  }, [providers, apiKeys]);

  const presetById = useMemo(() => new Map(allProviders.map((p) => [p.id, p])), [allProviders]);
  const grouped = useMemo(
    () => ({
      recommended: allProviders.filter((p) => p.group === "recommended"),
      local: allProviders.filter((p) => p.group === "local"),
      other: allProviders.filter((p) => p.group === "other"),
    }),
    [allProviders]
  );

  const modelQuery = useProviderModels(
    modelTarget?.providerId ?? null,
    modelTarget?.pendingKey,
    !!modelTarget && !!modelTarget.preset.fetchModels
  );
  const mergedModels = modelTarget
    ? mergePresetAndFetched(modelTarget.preset, modelQuery.data?.models)
    : [];

  const openKeyDialog = (providerId: string, isChange: boolean) => {
    setKeyInput("");
    setEndpointInput("");
    setCustomNameInput("");
    setKeyTarget({ providerId, preset: presetById.get(providerId), isChange });
  };

  const handleSaveKey = async () => {
    if (!keyTarget) return;
    const isCustomNew = keyTarget.providerId === "custom:new";
    let providerId = keyTarget.providerId;
    let label: string | undefined;

    if (isCustomNew) {
      const slug = slugifyName(customNameInput);
      if (!slug) {
        toast({ title: "Name required", description: "Give the custom provider a name.", variant: "destructive" });
        return;
      }
      providerId = `custom:${slug}`;
    }
    if (needsEndpoint(isCustomNew ? "custom:new" : providerId)) {
      if (!endpointInput.trim()) {
        toast({
          title: "Endpoint required",
          description: isCustomNew
            ? "Enter the OpenAI-compatible base URL (e.g. http://localhost:11434/v1)."
            : "Enter the Azure OpenAI endpoint (stored with the key).",
          variant: "destructive",
        });
        return;
      }
      // Endpoint persists in AIProviderKey.label as JSON (registry convention).
      label = JSON.stringify({ baseUrl: endpointInput.trim() });
    }
    if (!keyInput.trim()) {
      toast({ title: "Key required", description: "Paste the provider API key.", variant: "destructive" });
      return;
    }

    setSavingKey(true);
    try {
      if (keyTarget.isChange) {
        const existing = (apiKeys as ApiKey[]).filter((k) => k.provider === providerId);
        for (const k of existing) await deleteKey.mutateAsync(k.id);
      }
      await createKey.mutateAsync({ provider: providerId, apiKey: keyInput.trim(), label });
      const preset = presetById.get(providerId) ?? {
        id: providerId,
        label: prettifySlug(providerId.replace(/^custom:/, "")),
        baseUrl: "",
        keyPrefix: null,
        authStyle: "bearer",
        protocol: "openai",
        defaultModel: "",
        presetModels: [],
        fetchModels: true,
        group: "other",
      } as ProviderPreset;
      setKeyTarget(null);
      setModelTarget({ providerId, preset, pendingKey: keyInput.trim() });
    } catch {
      // toasts handled by the key hooks
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveProvider = async (providerId: string) => {
    try {
      const existing = (apiKeys as ApiKey[]).filter((k) => k.provider === providerId);
      for (const k of existing) await deleteKey.mutateAsync(k.id);
      // Clear the model override too (empty string = use default).
      await updateModels.mutateAsync({ [providerId]: "" });
    } catch {
      // toasts handled by the hooks
    }
  };

  const handleSaveModel = async (model: string) => {
    if (!modelTarget) return;
    try {
      await setModel.mutateAsync({ providerId: modelTarget.providerId, model: model.trim() });
      setModelTarget(null);
    } catch {
      // toast handled by useSetProviderModel
    }
  };

  const keyTargetLabel = keyTarget
    ? keyTarget.providerId === "custom:new"
      ? "Custom provider"
      : (keyTarget.preset?.label ?? prettifySlug(keyTarget.providerId.replace(/^custom:/, "")))
    : "";

  return (
    <section className="surface-card p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="section-title">AI providers</h2>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Add provider
        </Button>
      </div>
      <div className="mt-2 border-t border-rule" />

      <p className="mt-3 mb-4 text-sm text-ink-3">
        Connect an LLM provider, then pick the model it uses. Legacy{" "}
        <code>ATS_MODEL</code>, <code>RESUME_TAILOR_MODEL</code> and <code>RESUME_PARSE_MODEL</code>{" "}
        env vars are still honored when no model is set here.
      </p>

      {providersLoading ? (
        <p className="flex items-center gap-2 text-sm text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
        </p>
      ) : (
        <div className="space-y-2">
          {allProviders.map((p) => {
            const stored = (apiKeys as ApiKey[]).filter((k) => k.provider === p.id);
            const selected = modelSettings?.models[p.id] ?? p.defaultModel ?? "";
            const isCustom = !!modelSettings?.overrides?.[p.id];
            return (
              <div key={p.id} className="flex items-center justify-between gap-3 border-b border-rule py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{p.label}</span>
                    {stored.length > 0 ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Badge variant="outline" className="text-xs text-ink-3">no key</Badge>
                    )}
                    {isCustom ? (
                      <Badge variant="secondary" className="text-xs">Custom model</Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-ink-3">Default model</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs2 text-ink-3">
                    {stored.length > 0 ? stored[0].maskedKey : "Not connected"}
                    {selected ? ` · ${selected}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {stored.length > 0 ? (
                    <>
                      <button
                        type="button"
                        className="text-xs2 text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                        onClick={() => openKeyDialog(p.id, true)}
                      >
                        Change
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-ink-3"
                            aria-label={`More actions for ${p.label}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-xs2"
                            onClick={() => setModelTarget({ providerId: p.id, preset: p })}
                          >
                            Model
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-xs2 text-destructive"
                            onClick={() => void handleRemoveProvider(p.id)}
                          >
                            Remove provider
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => openKeyDialog(p.id, false)}>
                      Connect
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add provider picker */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Add provider</DialogTitle>
            <DialogDescription>Search providers, then enter a key and pick a model.</DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput placeholder="Search providers…" />
            <CommandList className="max-h-72">
              <CommandEmpty>No provider found.</CommandEmpty>
              <CommandGroup heading="Recommended">
                {grouped.recommended.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`${p.label} ${p.id}`}
                    onSelect={() => {
                      setAddOpen(false);
                      openKeyDialog(p.id, false);
                    }}
                  >
                    {p.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Local">
                {grouped.local.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`${p.label} ${p.id}`}
                    onSelect={() => {
                      setAddOpen(false);
                      openKeyDialog(p.id, false);
                    }}
                  >
                    {p.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Other">
                {grouped.other.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`${p.label} ${p.id}`}
                    onSelect={() => {
                      setAddOpen(false);
                      openKeyDialog(p.id, false);
                    }}
                  >
                    {p.label}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Custom">
                <CommandItem
                  value="Custom OpenAI-compatible provider"
                  onSelect={() => {
                    setAddOpen(false);
                    openKeyDialog("custom:new", false);
                  }}
                >
                  Custom provider…
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      {/* Key entry dialog */}
      <Dialog open={!!keyTarget} onOpenChange={(open) => !open && setKeyTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{keyTarget?.isChange ? `Change key — ${keyTargetLabel}` : `Connect ${keyTargetLabel}`}</DialogTitle>
            <DialogDescription>
              Keys are encrypted at rest and never shared. After saving, pick the model to use.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {keyTarget?.providerId === "custom:new" && (
              <div className="grid gap-2">
                <Label htmlFor="custom-name">Provider name</Label>
                <Input
                  id="custom-name"
                  value={customNameInput}
                  onChange={(e) => setCustomNameInput(e.target.value)}
                  placeholder="My LLM server"
                />
              </div>
            )}
            {keyTarget && needsEndpoint(keyTarget.providerId) && (
              <div className="grid gap-2">
                <Label htmlFor="provider-endpoint">
                  {keyTarget.providerId === "azure-openai" ? "Azure endpoint" : "Base URL"}
                </Label>
                <Input
                  id="provider-endpoint"
                  value={endpointInput}
                  onChange={(e) => setEndpointInput(e.target.value)}
                  placeholder={
                    keyTarget.providerId === "azure-openai"
                      ? "https://{resource}.openai.azure.com/openai/v1"
                      : "https://my-host:1234/v1"
                  }
                  spellCheck={false}
                  className="text-sm"
                />
                {keyTarget.providerId === "azure-openai" && (
                  <p className="text-xs2 text-ink-3">
                    The model field takes your deployment name.
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="provider-key">API key</Label>
              <Input
                id="provider-key"
                type="password"
                autoComplete="off"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={
                  keyTarget?.preset?.keyPrefix
                    ? `Starts with ${keyTarget.preset.keyPrefix}…`
                    : "Paste key…"
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKeyTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveKey} disabled={savingKey}>
              {savingKey ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                "Save & pick model"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Model picker dialog */}
      <Dialog open={!!modelTarget} onOpenChange={(open) => !open && setModelTarget(null)}>
        <DialogContent className="p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Pick a model</DialogTitle>
            <DialogDescription>
              {modelTarget && (presetById.get(modelTarget.providerId)?.label ?? modelTarget.providerId)}
              {modelTarget?.preset.fetchModels
                ? " — fetched live from the provider, presets first."
                : " — this provider has no model list; enter the model (deployment) name."}
            </DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput placeholder="Search models…" />
            <CommandList className="max-h-72">
              {modelQuery.isFetching ? (
                <p className="flex items-center gap-2 px-4 py-6 text-sm text-ink-3">
                  <Loader2 className="h-4 w-4 animate-spin" /> Fetching models…
                </p>
              ) : (
                <>
                  <CommandEmpty>
                    No match — type the model id below and save it manually.
                  </CommandEmpty>
                  {mergedModels.map((m) => (
                    <CommandItem
                      key={m}
                      value={m}
                      onSelect={() => handleSaveModel(m)}
                      className="text-sm"
                    >
                      {m}
                    </CommandItem>
                  ))}
                  {modelQuery.isError && mergedModels.length === 0 && (
                    <p className="px-4 py-2 text-xs2 text-ink-3">
                      Live fetch failed — enter the model id manually below.
                    </p>
                  )}
                </>
              )}
            </CommandList>
          </Command>
          <div className="flex items-center gap-2 border-t border-rule p-4">
            <Input
              value={manualModel}
              onChange={(e) => setManualModel(e.target.value)}
              placeholder="Or type a model id…"
              spellCheck={false}
              className="text-sm"
            />
            <Button
              variant="outline"
              onClick={() => handleSaveModel(manualModel)}
              disabled={!manualModel.trim() || setModel.isPending}
            >
              Save
            </Button>
          </div>
          {modelTarget && modelSettings?.overrides?.[modelTarget.providerId] && (
            <div className="flex justify-end border-t border-rule p-4 pt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleSaveModel("")}
                disabled={setModel.isPending}
              >
                Reset to default
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CatalogueSnapshotCard() {
  const { data: status } = useCatalogueStatus();
  const importSnapshot = useImportCatalogueSnapshot();
  const syncCatalogue = useSyncCatalogue();
  const [files, setFiles] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [feedUnavailable, setFeedUnavailable] = useState(false);

  const handleSync = async () => {
    setSyncResult(null);
    setSyncError(null);
    setFeedUnavailable(false);
    try {
      const data = await syncCatalogue.mutateAsync();
      setSyncResult(`Imported ${data.imported} postings (skipped ${data.skipped})`);
    } catch (error) {
      const shaped = error as { statusCode?: number; message?: string };
      if (shaped.statusCode === 502 || /not published/i.test(shaped.message ?? "")) {
        setFeedUnavailable(true);
      } else {
        setSyncError(shaped.message ?? "Catalogue sync failed.");
      }
    }
  };

  const handleImport = async () => {
    const snapshot = files.find((f) => f.name.endsWith(".gz"));
    const manifest = files.find((f) => f.name.endsWith(".json"));
    if (!snapshot || !manifest) {
      setLocalError("Select both catalogue.jsonl.gz and manifest.json.");
      return;
    }
    setLocalError(null);
    try {
      await importSnapshot.mutateAsync({ snapshot, manifest: await manifest.text() });
      setFiles([]);
    } catch {
      // The hook owns the destructive toast.
    }
  };

  const lastUpdated = status?.importedAt
    ? new Date(status.importedAt).toLocaleString()
    : "never";

  return (
    <section className="surface-card p-5">
      <h2 className="section-title">Catalogue snapshot</h2>
      <div className="mt-2 border-t border-rule" />

      <p className="mt-3 text-sm text-ink-3">
        The daily feed carries active listings with derived facets and a short
        description excerpt - never full job descriptions.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-ink-3">
        <span>
          <span className="font-medium text-ink">{(status?.active ?? 0).toLocaleString()}</span> active listings
        </span>
        <span>
          Last sync: <span className="text-ink">{lastUpdated}</span>
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={handleSync} disabled={syncCatalogue.isPending}>
          {syncCatalogue.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Syncing…
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" /> Sync catalogue
            </>
          )}
        </Button>
        {syncResult && <span className="text-sm text-ink-3">{syncResult}</span>}
      </div>

      {feedUnavailable && (
        <p className="mt-2 text-xs2 text-ink-3">The daily snapshot is not published yet.</p>
      )}
      {syncError && <p className="mt-2 text-xs2 text-destructive">{syncError}</p>}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="file"
          multiple
          accept=".gz,.json,application/gzip,application/json"
          className="text-sm sm:max-w-sm"
          onChange={(e) => {
            setFiles(Array.from(e.target.files ?? []));
            setLocalError(null);
          }}
        />
        <Button
          variant="outline"
          onClick={handleImport}
          disabled={importSnapshot.isPending || files.length === 0}
        >
          {importSnapshot.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Importing…
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" /> Import snapshot
            </>
          )}
        </Button>
      </div>

      {localError && <p className="mt-2 text-xs2 text-destructive">{localError}</p>}

      <p className="mt-3 text-xs2 text-ink-3">
        Select the <code>catalogue.jsonl.gz</code> and its <code>manifest.json</code>. The
        daily feed URL is configured with <code>CATALOGUE_FEED_URL</code>.
      </p>
    </section>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const logoutMutation = useLogout();
  const { toast } = useToast();

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

  return (
    <div className="flex h-full flex-col">
        {/* Page header */}
        <header className="border-b border-border bg-paper px-8 py-5">
          <h1 className="page-title text-ink">Settings</h1>
          <p className="mt-1 text-sm text-ink-3">
            Manage your account and API keys
          </p>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <PageBody width="prose" className="space-y-6 px-8 py-8">
            {/* API Keys (BYOK) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
            >
              <section className="surface-card p-5">
                <h2 className="section-title">API keys (bring your own)</h2>
                <div className="mt-2 border-t border-rule" />

                <p className="mt-3 mb-4 text-sm text-ink-3">
                  Add the keys you need - none are required to browse the built-in job boards. Keys are
                  encrypted and never shared. <span className="font-medium text-ink">*</span> marks the
                  providers most users need.
                </p>

                <div className="space-y-3">
                  {KEY_PROVIDERS.map((row) => {
                    const existing = (apiKeys as ApiKey[]).find((k) => k.provider === row.provider);
                    return (
                      <div key={row.provider} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div className="min-w-0">
                          <label className="flex items-center gap-1 text-sm font-medium text-ink">
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
                          className="text-xs2 text-primary hover:underline whitespace-nowrap"
                        >
                          View setup
                        </a>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-5 flex items-center justify-between">
                  <p className="text-xs2 text-ink-3">
                    Saved keys: {(apiKeys as ApiKey[]).filter((k) => isNonLlmKeyProvider(k.provider)).length}
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

                {(apiKeys as ApiKey[]).filter((k) => isNonLlmKeyProvider(k.provider)).length > 0 && (
                  <div className="mt-4 border-t border-rule pt-4">
                    <p className="mb-2 text-xs2 font-medium text-ink-3">Stored keys (remove any)</p>
                    {(apiKeys as ApiKey[]).some((k) => isNonLlmKeyProvider(k.provider) && !hasKeyProviderRow(k.provider)) && (
                      <p className="mb-2 text-xs2 text-ink-3">
                        Keys for boards Clearance no longer uses are kept here so you can remove them. They are not sent anywhere.
                      </p>
                    )}
                    <div className="space-y-2">
                      {(apiKeys as ApiKey[]).filter((k) => isNonLlmKeyProvider(k.provider)).map((k: ApiKey) => (
                        <div key={k.id} className="flex items-center justify-between gap-3 border-b border-rule py-2.5">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium capitalize text-ink">{k.provider}</span>
                              {!hasKeyProviderRow(k.provider) && (
                                <Badge variant="outline" className="text-xs text-ink-3">
                                  No longer used
                                </Badge>
                              )}
                              {k.lastValidatedAt ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                              ) : (
                                <AlertCircle className="h-3.5 w-3.5 text-warning" />
                              )}
                            </div>
                            <p className="truncate text-xs2 text-ink-3">{k.maskedKey}</p>
                          </div>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-ink-3" onClick={() => deleteKey.mutate(k.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </motion.div>

            {/* AI Providers (unified picker: key + model per LLM provider) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.27 }}
            >
              <AiProvidersCard />
            </motion.div>

            {/* Catalogue snapshot (daily feed sync + import) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.28 }}
            >
              <CatalogueSnapshotCard />
            </motion.div>

            {/* Setup Guide (provider -> features -> cost -> link) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.22 }}
            >
              <section className="surface-card p-5">
                <h2 className="section-title">Setup guide</h2>
                <div className="mt-2 border-t border-rule" />
                <p className="mt-3 mb-4 text-sm text-ink-3">
                  Clearance is self-hosted and bring-your-own-key (BYOK). Add only the providers for the
                  features you want - none are required to browse the built-in job boards. Click "Add provider"
                  in the AI Providers card above to connect an LLM.
                </p>
                <div className="space-y-3">
                  {SETUP_PROVIDERS.map((p) => (
                    <div key={p.name} className="border-b border-rule py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-ink">{p.name}</span>
                            <Badge
                              variant="secondary"
                              className={p.tier === "Recommended" ? "bg-primary/10 text-primary" : "bg-muted text-ink-3"}
                            >
                              {p.tier}
                            </Badge>
                            <Badge variant="outline" className="text-xs text-ink-3">{p.category}</Badge>
                          </div>
                          <p className="mt-1 text-xs2 text-ink-3">{p.unlocks}</p>
                          <p className="mt-1 text-xs2 text-ink-3">
                            <span className="font-medium text-ink">Cost:</span> {p.cost}
                          </p>
                        </div>
                        <a href={p.link} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">Setup</Button>
                        </a>
                      </div>

                      <div className="mt-3 border-l-2 border-rule pl-3 text-xs2">
                        <p className="font-medium text-ink">Key format</p>
                        <p className="mt-0.5 text-ink-3">{p.keyFormat}</p>
                      </div>

                      <div className="mt-3">
                        <p className="mb-1.5 text-xs2 font-medium text-ink">Setup steps</p>
                        <ol className="list-decimal space-y-1 pl-4 text-xs2 text-ink-3">
                          {p.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-xs2 text-ink-3">
                  Note: Firecrawl/Crawl4AI and RapidAPI cover <span className="font-medium">different</span> boards.
                  For LinkedIn/Indeed/ZipRecruiter/Bayt use RapidAPI; for Y Combinator/Wellfound/Instahyre/Sprout/Google
                  use Firecrawl or Crawl4AI (Crawl4AI can be self-hosted for free). Adzuna, USAJobs, Reed and Findwork are official
                  aggregators that need no scraping and work alongside the above.
                </p>
              </section>
            </motion.div>

            {/* Export Preferences */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <section className="surface-card p-5">
                <h2 className="section-title">Export preferences</h2>
                <div className="mt-2 border-t border-rule" />
                <div className="mt-3 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-ink">Default Format</p>
                      <p className="text-sm text-ink-3">
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
                      <p className="font-medium text-ink">Include Photo</p>
                      <p className="text-sm text-ink-3">
                        Add your photo to exported resumes
                      </p>
                    </div>
                    <Button variant="outline" size="sm">
                      Off
                    </Button>
                  </div>
                </div>
              </section>
            </motion.div>

            {/* Account Actions */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <section className="surface-card p-5">
                <h2 className="section-title">Account</h2>
                <div className="mt-2 border-t border-rule" />
                <div className="mt-3 space-y-3">
                  <Button
                    variant="outline"
                    className="w-fit justify-start"
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
              </section>
            </motion.div>
          </PageBody>
        </div>
      </div>

  );
}
