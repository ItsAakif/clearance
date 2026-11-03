import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-full bg-paper-2", className)} {...props} />;
}

export { Skeleton };
