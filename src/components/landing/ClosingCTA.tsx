import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { AnimatedButton } from "@/components/animations";

export const ClosingCTA = () => {
  return (
    <section className="border-t border-border bg-secondary/30 py-20 md:py-28">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5 }}
        >
          <h2 className="text-2xl font-semibold text-foreground md:text-3xl lg:text-4xl">
            Start with your resume. We'll show you what works.
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-muted-foreground">
            Upload an existing resume or build from scratch - get instant ATS feedback either way.
          </p>
          
          <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row sm:gap-4">
            <AnimatedButton asChild variant="hero" size="lg" glowOnHover>
              <Link to="/get-started">
                Start building
              </Link>
            </AnimatedButton>
            <AnimatedButton asChild variant="outline" size="lg">
              <Link to="/get-started?upload=true">
                Upload resume
              </Link>
            </AnimatedButton>
          </div>
        </motion.div>
      </div>
    </section>
  );
};
