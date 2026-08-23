import { cn } from "@/lib/utils";
import InteractiveDotGrid from "./InteractiveDotGrid";

interface DotGridSectionProps {
  children: React.ReactNode;
  className?: string;
  minHeight?: string;
}

export function DotGridSection({ 
  children, 
  className,
  minHeight = "min-h-[80vh]" 
}: DotGridSectionProps) {
  return (
    <section 
      className={cn("relative overflow-hidden", minHeight, className)}
      style={{
        background: `linear-gradient(180deg, hsl(var(--gradient-start)) 0%, hsl(var(--gradient-end)) 100%)`
      }}
    >
      <InteractiveDotGrid />
      <div className="relative z-10">
        {children}
      </div>
    </section>
  );
}
