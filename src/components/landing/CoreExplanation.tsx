import { motion } from "framer-motion";
import { PenLine, ScanSearch, Target } from "lucide-react";
import { Separator } from "@/components/ui/separator";

const features = [
  {
    icon: PenLine,
    title: "Build",
    description: "Structured resume editor with ATS-safe templates. No design tricks that break parsing.",
  },
  {
    icon: ScanSearch,
    title: "Scan",
    description: "Standalone ATS scan with real feedback on formatting, structure, and keywords.",
  },
  {
    icon: Target,
    title: "Match",
    description: "Job-based optimisation that creates resume variants tailored to each role.",
  },
];

export const CoreExplanation = () => {
  return (
    <section className="border-t border-border py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-20">
          {/* Left - Headline & Description */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          >
            <h2 className="text-3xl font-semibold leading-tight text-foreground md:text-4xl lg:text-[2.75rem] lg:leading-tight">
              Built around how ATS systems actually read resumes.
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
              Most resume builders focus on design. We focus on what hiring software 
              actually sees - so your resume gets read, not filtered out.
            </p>
          </motion.div>

          {/* Right - Feature list with visual structure */}
          <div className="space-y-0">
            {features.map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.5, delay: index * 0.1, ease: "easeOut" }}
              >
                {index > 0 && <Separator className="my-6" />}
                <div className="flex gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                    <feature.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">
                      {feature.title}
                    </h3>
                    <p className="mt-1.5 text-muted-foreground leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
