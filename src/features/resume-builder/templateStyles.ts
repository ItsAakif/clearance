// Template-specific styling configurations for DocumentEditor
// Each category has distinct visual characteristics

export type TemplateCategory = "classic" | "modern" | "minimal" | "creative" | "professional";

export interface TemplateStyle {
  // Colors
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headerBg: string;
  sectionBorderColor: string;
  
  // Typography
  headerFont: string;
  bodyFont: string;
  nameSize: string;
  sectionTitleSize: string;
  
  // Layout
  layout: "single-column" | "two-column" | "sidebar";
  headerAlignment: "center" | "left" | "right";
  sectionStyle: "underline" | "background" | "border-left" | "uppercase" | "simple";
  bulletStyle: "disc" | "circle" | "square" | "dash" | "arrow";
  
  // Spacing
  sectionSpacing: string;
  itemSpacing: string;
  
  // Special features
  showIcons: boolean;
  roundedCorners: boolean;
  shadowEffects: boolean;
}

// Style configurations by category
export const templateStyles: Record<TemplateCategory, TemplateStyle> = {
  classic: {
    primaryColor: "#1a1a1a",
    secondaryColor: "#4a4a4a",
    accentColor: "#2563eb",
    headerBg: "transparent",
    sectionBorderColor: "#d1d5db",
    
    headerFont: "'Times New Roman', Georgia, serif",
    bodyFont: "'Times New Roman', Georgia, serif",
    nameSize: "1.75rem",
    sectionTitleSize: "0.75rem",
    
    layout: "single-column",
    headerAlignment: "center",
    sectionStyle: "underline",
    bulletStyle: "disc",
    
    sectionSpacing: "1.25rem",
    itemSpacing: "1rem",
    
    showIcons: true,
    roundedCorners: false,
    shadowEffects: false,
  },
  
  modern: {
    primaryColor: "#0f172a",
    secondaryColor: "#475569",
    accentColor: "#6366f1",
    headerBg: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
    sectionBorderColor: "#e2e8f0",
    
    headerFont: "'Inter', 'Segoe UI', system-ui, sans-serif",
    bodyFont: "'Inter', 'Segoe UI', system-ui, sans-serif",
    nameSize: "2rem",
    sectionTitleSize: "0.875rem",
    
    layout: "single-column",
    headerAlignment: "left",
    sectionStyle: "border-left",
    bulletStyle: "arrow",
    
    sectionSpacing: "1.5rem",
    itemSpacing: "1rem",
    
    showIcons: true,
    roundedCorners: true,
    shadowEffects: true,
  },
  
  minimal: {
    primaryColor: "#18181b",
    secondaryColor: "#71717a",
    accentColor: "#10b981",
    headerBg: "transparent",
    sectionBorderColor: "#e4e4e7",
    
    headerFont: "'Helvetica Neue', Arial, sans-serif",
    bodyFont: "'Helvetica Neue', Arial, sans-serif",
    nameSize: "1.5rem",
    sectionTitleSize: "0.625rem",
    
    layout: "single-column",
    headerAlignment: "left",
    sectionStyle: "uppercase",
    bulletStyle: "dash",
    
    sectionSpacing: "1.75rem",
    itemSpacing: "0.75rem",
    
    showIcons: false,
    roundedCorners: false,
    shadowEffects: false,
  },
  
  creative: {
    primaryColor: "#1e1b4b",
    secondaryColor: "#4338ca",
    accentColor: "#f43f5e",
    headerBg: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)",
    sectionBorderColor: "#c7d2fe",
    
    headerFont: "'Poppins', 'Montserrat', sans-serif",
    bodyFont: "'Open Sans', 'Roboto', sans-serif",
    nameSize: "2.25rem",
    sectionTitleSize: "0.875rem",
    
    layout: "two-column",
    headerAlignment: "center",
    sectionStyle: "background",
    bulletStyle: "circle",
    
    sectionSpacing: "1.25rem",
    itemSpacing: "0.875rem",
    
    showIcons: true,
    roundedCorners: true,
    shadowEffects: true,
  },
  
  professional: {
    primaryColor: "#0c4a6e",
    secondaryColor: "#0369a1",
    accentColor: "#0284c7",
    headerBg: "#f0f9ff",
    sectionBorderColor: "#bae6fd",
    
    headerFont: "'Georgia', 'Cambria', serif",
    bodyFont: "'Calibri', 'Arial', sans-serif",
    nameSize: "1.875rem",
    sectionTitleSize: "0.75rem",
    
    layout: "single-column",
    headerAlignment: "center",
    sectionStyle: "underline",
    bulletStyle: "square",
    
    sectionSpacing: "1.5rem",
    itemSpacing: "1rem",
    
    showIcons: true,
    roundedCorners: false,
    shadowEffects: false,
  },
};

// Get style for a specific template by its category
export function getTemplateStyle(category: TemplateCategory): TemplateStyle {
  return templateStyles[category] || templateStyles.classic;
}

// Get bullet character based on style
export function getBulletCharacter(style: TemplateStyle["bulletStyle"]): string {
  switch (style) {
    case "disc": return "•";
    case "circle": return "○";
    case "square": return "▪";
    case "dash": return "-";
    case "arrow": return "›";
    default: return "•";
  }
}
