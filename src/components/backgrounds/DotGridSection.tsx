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
      className={cn("relative overflow-hidden bg-paper", minHeight, className)}
    >
      <InteractiveDotGrid />
      <div className="relative z-10">
        {children}
      </div>
    </section>
  );
}
