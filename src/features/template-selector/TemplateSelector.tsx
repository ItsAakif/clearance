import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layout, SlidersHorizontal } from "lucide-react";
import { TemplateCard } from "./TemplateCard";
import { TemplateControls } from "./TemplateControls";
import { ResumeTemplate, TemplateSettings, templates } from "@/types/template";

interface TemplateSelectorProps {
  selectedTemplateId: string;
  settings: TemplateSettings;
  onSelectTemplate: (templateId: string) => void;
  onUpdateSetting: <K extends keyof TemplateSettings>(key: K, value: TemplateSettings[K]) => void;
  onReset: () => void;
}

export function TemplateSelector({
  selectedTemplateId,
  settings,
  onSelectTemplate,
  onUpdateSetting,
  onReset,
}: TemplateSelectorProps) {
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Layout className="mr-2 h-4 w-4" />
          {selectedTemplate?.name || "Template"}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[400px] sm:w-[540px]">
        <SheetHeader>
          <SheetTitle>Template & Layout</SheetTitle>
        </SheetHeader>

        <Tabs defaultValue="templates" className="mt-6">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="templates" className="gap-2">
              <Layout className="h-4 w-4" />
              Templates
            </TabsTrigger>
            <TabsTrigger value="controls" className="gap-2">
              <SlidersHorizontal className="h-4 w-4" />
              Controls
            </TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="mt-4">
            <div className="grid grid-cols-2 gap-3">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  isSelected={selectedTemplateId === template.id}
                  onSelect={() => onSelectTemplate(template.id)}
                />
              ))}
            </div>
          </TabsContent>

          <TabsContent value="controls" className="mt-4">
            <TemplateControls
              settings={settings}
              onUpdateSetting={onUpdateSetting}
              onReset={onReset}
            />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
