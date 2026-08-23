import { apiClient } from './client';

export interface AdminTemplateStatus {
  id: string;
  fileName: string;
  analyzedAt: string;
  sectionCount: number;
  hasPreview: boolean;
}

export const adminApi = {
  getStatus() {
    return apiClient.get<{ email: string; isAdmin: boolean }>('/admin/status');
  },
  getTemplates() {
    return apiClient.get<AdminTemplateStatus[]>('/admin/templates');
  },
  refreshTemplates() {
    return apiClient.post<{ message: string; templates: number; ids: string[] }>('/templates/refresh');
  },
  generateTemplatePreviews() {
    return apiClient.post<{ generated: number; previews: Array<{ id: string; url: string }> }>('/templates/generate-previews');
  },
};
