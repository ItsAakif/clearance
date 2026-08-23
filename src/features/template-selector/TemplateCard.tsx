import { Check, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ResumeTemplate } from "@/types/template";
import { cn } from "@/lib/utils";

interface TemplateCardProps {
  template: ResumeTemplate;
  isSelected: boolean;
  onSelect: () => void;
}

export function TemplateCard({ template, isSelected, onSelect }: TemplateCardProps) {
  return (
    <Card
      className={cn(
        "relative cursor-pointer overflow-hidden transition-all duration-200",
        "hover:shadow-lg hover:-translate-y-0.5",
        isSelected && "ring-2 ring-primary shadow-md"
      )}
      onClick={onSelect}
    >
      {/* Template Preview */}
      <div className="aspect-[8.5/11] bg-card border-b border-border p-3">
        <div className="h-full w-full rounded bg-background p-2 shadow-inner">
          {/* Mini resume preview */}
          <div className="space-y-1.5">
            <div className="h-2 w-16 rounded-sm bg-foreground/80" />
            <div className="flex gap-2">
              <div className="h-1 w-8 rounded-sm bg-muted-foreground/40" />
              <div className="h-1 w-8 rounded-sm bg-muted-foreground/40" />
              <div className="h-1 w-6 rounded-sm bg-muted-foreground/40" />
            </div>
            <div className="mt-2 h-px w-full bg-border" />
            <div className="space-y-0.5 pt-1">
              <div className="h-1 w-10 rounded-sm bg-muted-foreground/60" />
              <div className="h-1 w-full rounded-sm bg-muted-foreground/20" />
              <div className="h-1 w-3/4 rounded-sm bg-muted-foreground/20" />
            </div>
            <div className="space-y-0.5 pt-1">
              <div className="h-1 w-12 rounded-sm bg-muted-foreground/60" />
              <div className="h-1 w-full rounded-sm bg-muted-foreground/20" />
              <div className="h-1 w-5/6 rounded-sm bg-muted-foreground/20" />
            </div>
          </div>
        </div>
      </div>

      {/* Template Info */}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-medium text-foreground text-sm">{template.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {template.description}
            </p>
          </div>
          {isSelected && (
            <div className="shrink-0 rounded-full bg-primary p-1">
              <Check className="h-3 w-3 text-primary-foreground" />
            </div>
          )}
        </div>

        {template.isAtsOptimized && (
          <Badge variant="secondary" className="mt-2 gap-1 text-[10px]">
            <ShieldCheck className="h-2.5 w-2.5" />
            ATS-Safe
          </Badge>
        )}
      </div>
    </Card>
  );
}
