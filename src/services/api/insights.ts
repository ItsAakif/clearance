import { apiClient } from './client';

export interface CatalogueInsights {
  totalOpen: number;
  postedLast30: number;
  topSkills: { skill: string; count: number }[];
  workMode: { mode: 'remote' | 'hybrid'; count: number }[];
  seniority: { level: string; count: number }[];
  salaryByRegion: { region: string; currency: string; median: number; count: number }[];
  topCompanies: { company: string; count: number }[];
  workModeStated: number;
  seniorityStated: number;
  updatedAt: string;
}

export const insightsApi = {
  catalogue: () => apiClient.get<CatalogueInsights>('/insights/catalogue'),
};