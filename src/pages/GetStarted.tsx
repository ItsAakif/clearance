import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { Upload, PenLine, Sparkles, ArrowRight, Wand2 } from "lucide-react";
import { motion } from "framer-motion";
import { BlurText, AnimatedButton } from "@/components/animations";

interface PathCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  features: string[];
  href: string;
  buttonText: string;
  accentColor: string;
  delay: number;
}

function PathCard({ icon, title, description, features, href, buttonText, accentColor, delay }: PathCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      className="h-full"
    >
      <Card className="group relative flex h-full flex-col border border-border bg-card p-6 shadow-md transition-all duration-300 hover:border-primary/30 hover:shadow-lg">
        {/* Icon */}
        <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-xl ${accentColor}`}>
          {icon}
        </div>

        {/* Title & Description */}
        <h3 className="mb-2 text-lg font-semibold text-foreground">{title}</h3>
        <p className="mb-4 text-sm text-muted-foreground">{description}</p>

        {/* Features */}
        <ul className="mb-6 flex-1 space-y-2">
          {features.map((feature, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
              <div className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary/60" />
              {feature}
            </li>
          ))}
        </ul>

        {/* CTA */}
        <AnimatedButton asChild variant="hero" className="w-full gap-2" glowOnHover>
          <Link to={href}>
            {buttonText}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </AnimatedButton>
      </Card>
    </motion.div>
  );
}

export default function GetStartedPage() {
  const paths: Omit<PathCardProps, "delay">[] = [
    {
      icon: <Upload className="h-6 w-6 text-foreground" />,
      title: "Upload Existing Resume",
      description: "Already have a resume? Import it and we'll help you optimise it.",
      features: [
        "Supports PDF, DOCX, and TXT files",
        "Auto-extracts sections and content",
        "Instant ATS compatibility check",
        "Edit and improve in our builder",
      ],
      href: "/app/upload",
      buttonText: "Upload Resume",
      accentColor: "bg-accent-teal",
    },
    {
      icon: <PenLine className="h-6 w-6 text-foreground" />,
      title: "Build From Scratch",
      description: "Start fresh with our guided resume builder and templates.",
      features: [
        "Step-by-step section editing",
        "ATS-optimised templates",
        "Real-time preview",
        "Export to PDF or DOCX",
      ],
      href: "/app/build",
      buttonText: "Start Building",
      accentColor: "bg-accent-sage",
    },
    {
      icon: <Wand2 className="h-6 w-6 text-foreground" />,
      title: "AI Resume Builder",
      description: "Answer a few questions and let AI draft your resume - no job description needed.",
      features: [
        "Guided questionnaire (role, skills, achievements)",
        "AI drafts tailored content for you",
        "Full manual editing afterwards",
        "Optionally match to a job later",
      ],
      href: "/get-started/ai-build",
      buttonText: "Build With AI",
      accentColor: "bg-transparent",
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <LandingHeader />

      <DotGridSection className="flex items-center justify-center" minHeight="min-h-screen">
        <div className="mx-auto w-full max-w-5xl px-6 py-24 pt-32">
          {/* Step Indicator */}
          {/* Header */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mb-12 text-center"
          >
            <BlurText
              text="How would you like to create your resume?"
              className="mx-auto max-w-2xl text-2xl font-semibold text-foreground md:text-3xl"
              as="h1"
              animateBy="words"
              delay={50}
            />
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8 }}
              className="mx-auto mt-4 max-w-lg text-muted-foreground"
            >
              Choose the path that works best for you. You can always switch approaches later.
            </motion.p>
          </motion.div>

          {/* Path Cards */}
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {paths.map((path, i) => (
              <PathCard key={path.title} {...path} delay={0.4 + i * 0.1} />
            ))}
          </div>

          {/* Bottom note */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="mt-10 text-center text-sm text-muted-foreground"
          >
            All paths lead to our powerful resume editor with live preview
          </motion.p>
        </div>
      </DotGridSection>
    </div>
  );
}
