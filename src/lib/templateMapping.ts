const BACKEND_TO_RENDERER_TEMPLATE_MAP: Record<string, string> = {
  "Professional-Standard(Make-this-default)": "professional-standard",
  "professional-standard": "professional-standard",
  Standard: "professional-standard",
  Classic: "classic-elegant",
  Bullets: "accent-line",
  descriptive: "executive-classic",
  Accountant: "two-column-executive",
  "ats-minimilistic": "simple-ats",
  "Minimalist_1": "modern-minimal",
  "minimalist_2column": "split-equal",
  "Minimal-Green": "modern-minimal",
  "Minimal_Blue": "modern-minimal",
  "Graphic": "creative-designer",
  "Graphic2": "portfolio-designer",
  "Graphic3": "photo-header",
  "Desinger": "minimalist-designer",
  "Marketting": "modern-cards",
};

const RENDERER_TO_BACKEND_TEMPLATE_MAP: Record<string, string> = {
  "professional-standard": "Professional-Standard(Make-this-default)",
  "classic-elegant": "Classic",
  "accent-line": "Bullets",
  "executive-classic": "descriptive",
  "two-column-executive": "Accountant",
  "simple-ats": "ats-minimilistic",
  "modern-minimal": "Minimalist_1",
  "split-equal": "minimalist_2column",
  "creative-designer": "Graphic",
  "portfolio-designer": "Graphic2",
  "photo-header": "Graphic3",
  "minimalist-designer": "Desinger",
  "modern-cards": "Marketting",
};

export function mapBackendTemplateToRendererId(templateId?: string | null): string {
  if (!templateId) {
    return "professional-standard";
  }

  return BACKEND_TO_RENDERER_TEMPLATE_MAP[templateId] || templateId;
}

export function mapRendererTemplateToBackendId(templateId?: string | null): string {
  if (!templateId) {
    return "Professional-Standard(Make-this-default)";
  }

  return RENDERER_TO_BACKEND_TEMPLATE_MAP[templateId] || templateId;
}
