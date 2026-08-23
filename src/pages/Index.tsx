import { Link } from "react-router-dom";
import { LandingHeader } from "@/components/layout";
import { DotGridSection } from "@/components/backgrounds";
import { FileText, CheckCircle, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { motion } from "framer-motion";
import { BlurText, AnimatedButton } from "@/components/animations";
import {
  CoreExplanation,
  FeatureShowcase,
  TemplatesSection,
  ClosingCTA,
  Footer,
} from "@/components/landing";

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <LandingHeader />

      {/* Hero Section - UNCHANGED */}
      <DotGridSection className="flex items-center justify-center" minHeight="min-h-[90vh]">
        <div className="mx-auto w-full max-w-5xl px-6 py-24 pt-32 text-center">
          {/* Main headline */}
          <BlurText
            text="The resume builder for job seekers"
            className="text-4xl font-medium leading-tight tracking-tight text-muted-foreground md:text-5xl lg:text-6xl"
            as="h1"
            animateBy="words"
            delay={100}
          />
          <motion.h2
            initial={{ opacity: 0, filter: "blur(10px)" }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            transition={{ delay: 0.4, duration: 0.6 }}
            className="mt-2 text-4xl font-semibold leading-tight tracking-tight text-primary md:text-5xl lg:text-6xl"
          >
            who want their resume read.
          </motion.h2>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.5 }}
            className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground"
          >
            Build, optimise, and check ATS compatibility - without breaking formatting or guessing scores.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8, duration: 0.5 }}
            className="mt-10 flex flex-wrap justify-center gap-4"
          >
            <AnimatedButton asChild variant="hero" size="xl" glowOnHover>
              <Link to="/get-started">
                <FileText className="mr-2 h-5 w-5" />
                Start building
              </Link>
            </AnimatedButton>
            <AnimatedButton asChild variant="outline" size="xl">
              <Link to="/get-started?upload=true">
                Upload resume
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </AnimatedButton>
          </motion.div>
        </div>
      </DotGridSection>

      {/* Product Showcase - Two cards - UNCHANGED */}
      <section className="relative -mt-20 pb-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col items-center gap-4 md:flex-row md:items-start md:justify-center">
            {/* Before card */}
            <motion.div
              initial={{ opacity: 0, y: 40, rotate: -2 }}
              whileInView={{ opacity: 1, y: 0, rotate: -2 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
              className="w-full max-w-sm"
            >
              <p className="mb-3 text-center text-sm text-muted-foreground">Your raw resume</p>
              <Card className="overflow-hidden border border-border bg-card p-6 shadow-xl">
                <div className="flex items-center gap-2 mb-4">
                  <div className="h-3 w-3 rounded-full bg-destructive/60" />
                  <div className="h-3 w-3 rounded-full bg-warning/60" />
                  <div className="h-3 w-3 rounded-full bg-success/60" />
                </div>
                <h3 className="text-lg font-semibold text-foreground">John Smith Resume</h3>
                <p className="mt-1 text-sm text-muted-foreground">Last edited: today</p>
                <div className="mt-4 space-y-2">
                  <p className="text-sm text-muted-foreground">• 5+ years experience</p>
                  <p className="text-sm text-muted-foreground">• managed team of developers</p>
                  <p className="text-sm text-muted-foreground">• built apps for clients</p>
                </div>
              </Card>
            </motion.div>

            {/* After card */}
            <motion.div
              initial={{ opacity: 0, y: 40, rotate: 2 }}
              whileInView={{ opacity: 1, y: 0, rotate: 2 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="w-full max-w-sm md:mt-12"
            >
              <div className="mb-3 flex items-center justify-center gap-2">
                <p className="text-sm font-medium text-primary">ATS optimised</p>
              </div>
              <Card className="overflow-hidden border-2 border-primary/20 bg-card p-6 shadow-xl">
                <div className="flex items-center gap-2 mb-4">
                  <div className="h-3 w-3 rounded-full bg-destructive/60" />
                  <div className="h-3 w-3 rounded-full bg-warning/60" />
                  <div className="h-3 w-3 rounded-full bg-success/60" />
                </div>
                <h3 className="text-lg font-semibold text-foreground">John Smith Resume</h3>
                <p className="mt-1 text-sm text-muted-foreground">ATS Score: 94%</p>
                <div className="mt-4 space-y-2">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 text-success flex-shrink-0" />
                    <p className="text-sm text-foreground">Led cross-functional team of 8 engineers, delivering 3 major product launches</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 text-success flex-shrink-0" />
                    <p className="text-sm text-foreground">Architected scalable solutions serving 50K+ daily users</p>
                  </div>
                </div>
              </Card>
            </motion.div>
          </div>
        </div>
      </section>

      {/* New Sections */}
      <CoreExplanation />
      <FeatureShowcase />
      <TemplatesSection />
      <ClosingCTA />
      <Footer />
    </div>
  );
};

export default Index;
