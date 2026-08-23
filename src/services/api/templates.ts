// Templates API service - Get available resume templates with dynamic sections
// Integrates with backend template analyzer

import { apiClient } from "./client";
import { TemplateInfo, SectionDefinition, TemplateSampleContent } from "@/types/resume";

// ==================== API RESPONSE TYPES ====================

interface TemplateListItem {
  id: string;
  name: string;
  fileName?: string;
  description?: string;
  category?: string;
  tags?: string[];
  recommended?: string[];
  isAtsOptimized?: boolean;
  sectionCount?: number;
  sections: SectionDefinition[];
  placeholders?: string[];
  sampleContent?: TemplateSampleContent;
  defaultSettings?: {
    marginX: number;
    marginY: number;
    fontSize: number;
    lineSpacing: number;
    sectionSpacing: number;
    primaryColor?: string;
    accentColor?: string;
  };
  analyzedAt?: string;
}

interface RefreshResponse {
  message: string;
  templates: number;
  ids: string[];
}

// ==================== API CLIENT ====================

export const templateApi = {
  /**
   * Get all available templates with their section definitions
   */
  async getAll(): Promise<TemplateInfo[]> {
    const templates = await apiClient.get<TemplateListItem[]>('/templates');
    return templates.map(t => ({
      id: t.id,
      name: t.name,
      fileName: t.fileName,
      description: t.description,
      category: t.category,
      tags: t.tags,
      recommended: t.recommended,
      isAtsOptimized: t.isAtsOptimized,
      sectionCount: t.sectionCount || t.sections.length,
      sections: t.sections,
      placeholders: t.placeholders,
      sampleContent: t.sampleContent,
      defaultSettings: t.defaultSettings,
    }));
  },

  /**
   * Get a single template by ID with full section definitions
   */
  async getById(id: string): Promise<TemplateInfo | null> {
    try {
      const template = await apiClient.get<TemplateListItem>(`/templates/${id}`);
      return {
        id: template.id,
        name: template.name,
        fileName: template.fileName,
        description: template.description,
        category: template.category,
        isAtsOptimized: template.isAtsOptimized,
        sections: template.sections,
        placeholders: template.placeholders,
        sampleContent: template.sampleContent,
        defaultSettings: template.defaultSettings,
      };
    } catch (error) {
      console.error(`Failed to fetch template ${id}:`, error);
      return null;
    }
  },

  /**
   * Get just the sections for a template (for form rendering)
   * This is a lighter endpoint when you only need sections
   */
  async getSections(id: string): Promise<SectionDefinition[]> {
    try {
      return await apiClient.get<SectionDefinition[]>(`/templates/${id}/sections`);
    } catch (error) {
      console.error(`Failed to fetch sections for template ${id}:`, error);
      return [];
    }
  },

  /**
   * Force refresh all templates (re-analyze .docx files)
   * Call this after adding/modifying templates in backend/templates/
   */
  async refresh(): Promise<RefreshResponse> {
    return apiClient.post<RefreshResponse>('/templates/refresh');
  },
};

// ==================== HOOKS-FRIENDLY EXPORTS ====================

/**
 * Fetch all templates - for use in React Query or similar
 */
export async function fetchTemplates(): Promise<TemplateInfo[]> {
  return templateApi.getAll();
}

/**
 * Fetch single template - for use in React Query or similar
 */
export async function fetchTemplate(id: string): Promise<TemplateInfo | null> {
  return templateApi.getById(id);
}

/**
 * Fetch template sections - for use in React Query or similar
 */
export async function fetchTemplateSections(id: string): Promise<SectionDefinition[]> {
  return templateApi.getSections(id);
}

export default templateApi;
