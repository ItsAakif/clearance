import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { AnimatedButton } from "@/components/animations";

const templates = [
  { name: "Classic Professional", tag: "ATS-safe", featured: true },
  { name: "Modern Minimal", tag: "Single-column", featured: false },
  { name: "Executive", tag: "Recruiter-friendly", featured: false },
];

const benefits = [
  "Designed for ATS parsing, not just aesthetics",
  "Switch templates without losing content",
  "All templates tested against major ATS systems",
];

export const TemplatesSection = () => {
  return (
    <section className="border-t border-border py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          {/* Left - Template previews */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="order-2 lg:order-1"
          >
            <div className="grid grid-cols-3 gap-3 md:gap-4">
              {templates.map((template, i) => (
                <motion.div
                  key={template.name}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  whileHover={{ y: -4, scale: 1.02 }}
                  className={`group relative overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-lg ${
                    template.featured ? "border-primary/40" : "border-border"
                  }`}
                >
                  {/* Template preview mock */}
                  <div className="aspect-[3/4] bg-muted/30 p-3">
                    {/* Header area */}
                    <div className="mb-3 h-3 w-2/3 rounded bg-muted" />
                    <div className="mb-2 h-2 w-1/2 rounded bg-muted/70" />
                    
                    {/* Content lines */}
                    <div className="mt-4 space-y-1.5">
                      <div className="h-1.5 w-full rounded bg-muted/50" />
                      <div className="h-1.5 w-5/6 rounded bg-muted/50" />
                      <div className="h-1.5 w-4/5 rounded bg-muted/50" />
                    </div>
                    
                    {/* Section */}
                    <div className="mt-3">
                      <div className="mb-1.5 h-2 w-1/3 rounded bg-muted" />
                      <div className="h-1.5 w-full rounded bg-muted/50" />
                      <div className="mt-1 h-1.5 w-3/4 rounded bg-muted/50" />
                    </div>
                  </div>

                  {/* Label */}
                  <div className="border-t border-border bg-background p-2.5">
                    <p className="text-xs font-medium text-foreground">{template.name}</p>
                    <span className={`mt-1 inline-block text-[10px] font-medium ${
                      template.featured ? "text-primary" : "text-muted-foreground"
                    }`}>
                      {template.tag}
                    </span>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Right - Copy */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="order-1 lg:order-2"
          >
            <div className="mb-4 inline-flex rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
              Illustrative preview cards
            </div>
            <h2 className="text-2xl font-semibold text-foreground md:text-3xl">
              Templates that work with ATS - not against it.
            </h2>
            
            <ul className="mt-6 space-y-3">
              {benefits.map((benefit, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: 10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.2 + i * 0.1 }}
                  className="flex items-start gap-3 text-muted-foreground"
                >
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <span>{benefit}</span>
                </motion.li>
              ))}
            </ul>

            <div className="mt-8">
              <AnimatedButton asChild variant="outline" size="lg">
                <Link to="/ats-scan">
                  Check your ATS score
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </AnimatedButton>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};
