import { Link } from "react-router-dom";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import { BlurText, AnimatedButton } from "@/components/animations";

interface PathProps {
  title: string;
  description: string;
  features: string[];
  href: string;
  buttonText: string;
}

function PathColumn({ title, description, features, href, buttonText }: PathProps) {
  return (
    <div className="surface-card flex flex-1 flex-col p-6">
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-sm text-ink-3">{description}</p>
      <ul className="mt-4 flex-1 space-y-1.5 text-sm text-ink-3">
        {features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      <AnimatedButton asChild variant="outline" className="mt-6 w-fit gap-2">
        <Link to={href}>
          {buttonText}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </AnimatedButton>
    </div>
  );
}

export default function GetStartedPage() {
  const paths: PathProps[] = [
    {
      title: "Upload existing resume",
      description: "Already have a resume? Import it and we'll help you optimise it.",
      features: [
        "Supports PDF, DOCX, and TXT files",
        "Auto-extracts sections and content",
        "Instant ATS compatibility check",
        "Edit and improve in our builder",
      ],
      href: "/app/upload",
      buttonText: "Upload resume",
    },
    {
      // T1110: `/app/build` is deleted (FREEZE A-24). This column now offers the Studio, which
      // is its successor, so the copy is rewritten rather than left describing a questionnaire
      // the app no longer has: a column promising "guided questionnaire" that leads to a
      // redirect is a dead end with marketing on it.
      title: "Start from scratch",
      description: "Build your resume as structured blocks, rendered by the typesetter.",
      features: [
        "Block-by-block structure editing",
        "A4 templates rendered by the typesetter",
        "Every save is a new, immutable revision",
        "Export to PDF or DOCX",
      ],
      href: "/app/studio",
      buttonText: "Open the Studio",
    },
    {
      // T1110: `/get-started/ai-build` is deleted (FREEZE A-25). The questionnaire that fed
      // the fabricating `POST /ai/generate-resume` is retired, and its successor - the Career
      // Interview wizard - is not built yet, so the honest destination is the evidence layer
      // that wizard would feed: import what you have and confirm it.
      title: "Import and verify",
      description: "Bring in what you already have, then confirm each statement before it can be rendered.",
      features: [
        "Import a resume or fill in the interview",
        "Every statement lands as unconfirmed",
        "You confirm; nothing is confirmed for you",
        "Optionally match to a job later",
      ],
      href: "/app/profile",
      buttonText: "Go to career record",
    },
  ];

  return (
    <div className="min-h-screen bg-paper">
      <LandingHeader />

      <DotGridSection className="flex items-center justify-center" minHeight="min-h-screen">
        <div className="mx-auto w-full max-w-5xl px-6 py-24 pt-32">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="mb-12"
          >
            <BlurText
              text="How would you like to create your resume?"
              className="max-w-2xl text-2xl font-semibold text-ink md:text-3xl"
              as="h1"
              animateBy="words"
              delay={50}
            />
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5 }}
              className="mt-3 max-w-lg text-sm text-ink-3"
            >
              Choose the path that works best for you. You can always switch approaches later.
            </motion.p>
          </motion.div>

          <div className="flex flex-col gap-10 md:flex-row">
            {paths.map((path) => (
              <PathColumn key={path.title} {...path} />
            ))}
          </div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
            className="mt-10 text-sm text-ink-3"
          >
            All paths lead to the same resume editor with live preview.
          </motion.p>
        </div>
      </DotGridSection>
    </div>
  );
}
