import { useState, useCallback, useMemo } from "react";
import {
  TemplateSettings,
  ResumeTemplate,
  templates,
  defaultTemplateSettings,
} from "@/types/template";

export function useTemplateSettings(initialTemplateId: string = "classic") {
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplateId);
  const [settings, setSettings] = useState<TemplateSettings>(defaultTemplateSettings);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) || templates[0],
    [selectedTemplateId]
  );

  const selectTemplate = useCallback((templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (template) {
      setSelectedTemplateId(templateId);
      setSettings(template.defaultSettings);
    }
  }, []);

  const updateSetting = useCallback(
    <K extends keyof TemplateSettings>(key: K, value: TemplateSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const resetToDefaults = useCallback(() => {
    setSettings(selectedTemplate.defaultSettings);
  }, [selectedTemplate]);

  return {
    selectedTemplateId,
    selectedTemplate,
    settings,
    templates,
    selectTemplate,
    updateSetting,
    resetToDefaults,
  };
}
