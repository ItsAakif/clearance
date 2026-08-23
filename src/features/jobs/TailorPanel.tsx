import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Wand2, FileDown } from "lucide-react";
import { TemplateSelector } from "@/features/template-selector";
import { useTailorResume } from "@/hooks/useJobs";
import { tailorApi } from "@/services/api";
import { useToast } from "@/hooks/use-toast";
import type { TemplateSettings } from "@/types/template";

interface Props {
  jobId: string;
  resumeId: string;
  evaluationId?: string;
  jobDescription?: string;
  defaultTemplateId?: string;
}

export function TailorPanel({ jobId, resumeId, evaluationId, jobDescription, defaultTemplateId = "classic" }: Props) {
  const [templateId, setTemplateId] = useState(defaultTemplateId);
  const [settings, setSettings] = useState<TemplateSettings>({} as TemplateSettings);
  const tailor = useTailorResume();
  const { toast } = useToast();

  const handleTailor = async () => {
    const result = await tailor.mutateAsync({
      jobEvaluationId: evaluationId,
      jobDescription,
      resumeId,
      templateId,
      jobListingId: jobId,
    });
    toast({ title: "Resume tailored", description: `Saved as "${result.title}"` });
    return result;
  };

  const handleExport = async (format: 'pdf' | 'docx') => {
    const result = await tailor.mutateAsync({
      jobEvaluationId: evaluationId, jobDescription, resumeId, templateId, jobListingId: jobId,
    });
    const blob = await tailorApi.export(result.id, format);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.title}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <Wand2 className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Tailor to Template</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Rewrites your resume to mirror the job description and renders it with your chosen template.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <TemplateSelector
          selectedTemplateId={templateId}
          settings={settings}
          onSelectTemplate={setTemplateId}
          onUpdateSetting={(k, v) => setSettings((s) => ({ ...s, [k]: v }))}
          onReset={() => setSettings({} as TemplateSettings)}
        />
        <Button onClick={handleTailor} disabled={tailor.isPending}>
          {tailor.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
          Tailor Resume
        </Button>
      </div>

      {tailor.data && (
        <div className="mt-4 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => handleExport('pdf')}>
            <FileDown className="mr-1 h-4 w-4" /> Export PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport('docx')}>
            <FileDown className="mr-1 h-4 w-4" /> Export DOCX
          </Button>
        </div>
      )}
    </Card>
  );
}
