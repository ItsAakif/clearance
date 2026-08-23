import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PenLine, ScanSearch, Target, LayoutTemplate, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

const features = [
  {
    id: "builder",
    icon: PenLine,
    title: "Resume Builder",
    description: "Section-based editor that structures content for maximum ATS compatibility.",
    mockContent: {
      title: "Resume Editor",
      sections: ["Contact Info", "Summary", "Experience", "Skills", "Education"],
    },
  },
  {
    id: "ats",
    icon: ScanSearch,
    title: "ATS Scan",
    description: "Get instant feedback on formatting issues that break parsing.",
    mockContent: {
      title: "ATS Analysis",
      score: 94,
      issues: ["Formatting ✓", "Keywords ✓", "Structure ✓"],
    },
  },
  {
    id: "match",
    icon: Target,
    title: "Job Match",
    description: "Compare your resume against job descriptions and optimise per role.",
    mockContent: {
      title: "Job Matching",
      matchScore: 87,
      keywords: ["React", "TypeScript", "Node.js"],
    },
  },
  {
    id: "templates",
    icon: LayoutTemplate,
    title: "Template Switching",
    description: "Switch between ATS-safe layouts without losing content or scores.",
    mockContent: {
      title: "Templates",
      options: ["Classic", "Modern", "Minimal"],
    },
  },
  {
    id: "preview",
    icon: Eye,
    title: "Live Preview",
    description: "See changes in real-time as you edit your resume content.",
    mockContent: {
      title: "Live Preview",
      status: "Synced",
    },
  },
];

export const FeatureShowcase = () => {
  const [activeFeature, setActiveFeature] = useState(features[0]);

  return (
    <section className="border-t border-border bg-secondary/20 py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
          className="mb-12 md:mb-16"
        >
          <div className="mb-4 inline-flex rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
            Illustrative product demo
          </div>
          <h2 className="text-3xl font-semibold text-foreground md:text-4xl">
            One platform, every step covered.
          </h2>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            From blank page to job-ready resume - with real-time ATS feedback at every stage.
          </p>
        </motion.div>

        {/* Feature tabs + demo */}
        <div className="grid gap-8 lg:grid-cols-[320px_1fr] lg:gap-12">
          {/* Left - Feature selector */}
          {/* Desktop: vertical list */}
          <div className="hidden lg:block">
            <nav className="space-y-1">
              {features.map((feature) => (
                <button
                  key={feature.id}
                  onClick={() => setActiveFeature(feature)}
                  className={cn(
                    "group flex w-full items-start gap-3 rounded-lg px-4 py-3 text-left transition-all duration-200",
                    activeFeature.id === feature.id
                      ? "bg-background shadow-sm border border-border"
                      : "hover:bg-background/50"
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
                      activeFeature.id === feature.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground group-hover:text-foreground"
                    )}
                  >
                    <feature.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <span
                      className={cn(
                        "block text-sm font-medium transition-colors",
                        activeFeature.id === feature.id
                          ? "text-foreground"
                          : "text-muted-foreground group-hover:text-foreground"
                      )}
                    >
                      {feature.title}
                    </span>
                    {activeFeature.id === feature.id && (
                      <motion.p
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        className="mt-1 text-sm text-muted-foreground"
                      >
                        {feature.description}
                      </motion.p>
                    )}
                  </div>
                </button>
              ))}
            </nav>
          </div>

          {/* Mobile: horizontal scroll */}
          <div className="lg:hidden">
            <ScrollArea className="w-full whitespace-nowrap">
              <div className="flex gap-2 pb-3">
                {features.map((feature) => (
                  <button
                    key={feature.id}
                    onClick={() => setActiveFeature(feature)}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all duration-200",
                      activeFeature.id === feature.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <feature.icon className="h-4 w-4" />
                    {feature.title}
                  </button>
                ))}
              </div>
              <ScrollBar orientation="horizontal" className="h-1.5" />
            </ScrollArea>
            {/* Mobile description */}
            <p className="mt-3 text-sm text-muted-foreground">
              {activeFeature.description}
            </p>
          </div>

          {/* Right - Demo area */}
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="relative"
          >
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              {/* Mock browser header */}
              <div className="flex items-center gap-2 border-b border-border bg-secondary/50 px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-muted-foreground/20" />
                  <div className="h-3 w-3 rounded-full bg-muted-foreground/20" />
                  <div className="h-3 w-3 rounded-full bg-muted-foreground/20" />
                </div>
                <div className="ml-4 h-6 w-48 rounded bg-muted/50" />
              </div>

              {/* Demo content */}
              <div className="aspect-[4/3] p-6 md:aspect-video md:p-8">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeFeature.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.25 }}
                    className="h-full"
                  >
                    {activeFeature.id === "builder" && (
                      <BuilderMock sections={activeFeature.mockContent.sections} />
                    )}
                    {activeFeature.id === "ats" && (
                      <ATSMock score={activeFeature.mockContent.score} issues={activeFeature.mockContent.issues} />
                    )}
                    {activeFeature.id === "match" && (
                      <MatchMock score={activeFeature.mockContent.matchScore} keywords={activeFeature.mockContent.keywords} />
                    )}
                    {activeFeature.id === "templates" && (
                      <TemplatesMock options={activeFeature.mockContent.options} />
                    )}
                    {activeFeature.id === "preview" && (
                      <PreviewMock />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

// Mock components for demo area
const BuilderMock = ({ sections }: { sections: string[] }) => (
  <div className="flex h-full gap-4">
    <div className="w-1/3 space-y-2">
      {sections.map((section, i) => (
        <motion.div
          key={section}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.05 }}
          className={cn(
            "rounded-md px-3 py-2 text-sm",
            i === 2 ? "bg-primary/10 text-primary font-medium" : "bg-muted/50 text-muted-foreground"
          )}
        >
          {section}
        </motion.div>
      ))}
    </div>
    <div className="flex-1 rounded-lg border border-dashed border-border bg-muted/30 p-4">
      <div className="h-4 w-2/3 rounded bg-muted/50" />
      <div className="mt-3 h-3 w-full rounded bg-muted/40" />
      <div className="mt-2 h-3 w-5/6 rounded bg-muted/40" />
      <div className="mt-2 h-3 w-4/5 rounded bg-muted/40" />
    </div>
  </div>
);

const ATSMock = ({ score, issues }: { score: number; issues: string[] }) => (
  <div className="flex h-full flex-col items-center justify-center text-center">
    <motion.div
      initial={{ scale: 0 }}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 200, damping: 15 }}
      className="relative mb-6"
    >
      <div className="flex h-28 w-28 items-center justify-center rounded-full bg-success/10 text-4xl font-bold text-success md:h-32 md:w-32">
        {score}%
      </div>
    </motion.div>
    <p className="mb-4 text-sm font-medium text-foreground">ATS Compatibility Score</p>
    <div className="flex flex-wrap justify-center gap-2">
      {issues.map((issue, i) => (
        <motion.span
          key={issue}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 + i * 0.1 }}
          className="rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success"
        >
          {issue}
        </motion.span>
      ))}
    </div>
  </div>
);

const MatchMock = ({ score, keywords }: { score: number; keywords: string[] }) => (
  <div className="flex h-full flex-col">
    <div className="mb-4 flex items-center justify-between">
      <span className="text-sm font-medium text-foreground">Job Match Score</span>
      <span className="text-2xl font-bold text-primary">{score}%</span>
    </div>
    <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-muted">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${score}%` }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="h-full bg-primary"
      />
    </div>
    <p className="mb-3 text-xs text-muted-foreground">Matched keywords:</p>
    <div className="flex flex-wrap gap-2">
      {keywords.map((kw, i) => (
        <motion.span
          key={kw}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 + i * 0.1 }}
          className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
        >
          {kw}
        </motion.span>
      ))}
    </div>
  </div>
);

const TemplatesMock = ({ options }: { options: string[] }) => (
  <div className="grid h-full grid-cols-3 gap-3">
    {options.map((option, i) => (
      <motion.div
        key={option}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: i * 0.1 }}
        className={cn(
          "flex flex-col rounded-lg border p-3 transition-all",
          i === 1 ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-muted/30"
        )}
      >
        <div className="mb-2 aspect-[3/4] rounded bg-muted/50" />
        <span className={cn(
          "text-xs font-medium",
          i === 1 ? "text-primary" : "text-muted-foreground"
        )}>
          {option}
        </span>
      </motion.div>
    ))}
  </div>
);

const PreviewMock = () => (
  <div className="flex h-full gap-4">
    <div className="flex-1 space-y-3 rounded-lg border border-dashed border-border bg-muted/30 p-4">
      <div className="h-4 w-1/2 rounded bg-muted/50" />
      <div className="h-3 w-full rounded bg-muted/40" />
      <div className="h-3 w-3/4 rounded bg-muted/40" />
    </div>
    <div className="flex items-center">
      <motion.div
        animate={{ x: [0, 5, 0] }}
        transition={{ repeat: Infinity, duration: 1.5 }}
        className="text-primary"
      >
        →
      </motion.div>
    </div>
    <div className="flex-1 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="h-4 w-1/2 rounded bg-foreground/10" />
      <div className="mt-3 h-3 w-full rounded bg-muted/50" />
      <div className="mt-2 h-3 w-3/4 rounded bg-muted/50" />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ repeat: Infinity, duration: 2, repeatType: "reverse" }}
        className="mt-4 h-3 w-1/2 rounded bg-primary/30"
      />
    </div>
  </div>
);
