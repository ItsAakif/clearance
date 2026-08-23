// Resume API service - connected to Clearance backend

import type { Resume, ResumeVariant, PersonalInfo, ExperienceItem, EducationItem, ResumeSection, DynamicResumeData } from "@/types/resume";
import { apiClient } from "./client";

// Backend response types (may differ slightly from frontend types)
interface BackendResume {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  personalInfo: PersonalInfo;
  summary: string;
  experience: ExperienceItem[];
  education: EducationItem[];
  skills: string[];
  sections?: ResumeSection[];
  templateId?: string;
  templateSettings?: Record<string, unknown>;
  lastATSScore?: number;
  isArchived?: boolean;
  variants?: BackendVariant[];
}

interface BackendVariant {
  id: string;
  name: string;
  targetJob?: string;
  createdAt: string;
}

// Transform backend resume to frontend Resume type
function transformResume(backendResume: BackendResume): Resume {
  return {
    id: backendResume.id,
    name: backendResume.name,
    createdAt: backendResume.createdAt,
    updatedAt: backendResume.updatedAt,
    personalInfo: backendResume.personalInfo,
    summary: backendResume.summary,
    experience: backendResume.experience,
    education: backendResume.education,
    skills: (backendResume.skills || []).map((skill, index) => ({
      id: `skill-${index}`,
      name: skill,
    })),
    sections: backendResume.sections || [
      { id: 'personal', type: 'personal', title: 'Personal Information', order: 0, visible: true },
      { id: 'summary', type: 'summary', title: 'Professional Summary', order: 1, visible: true },
      { id: 'experience', type: 'experience', title: 'Work Experience', order: 2, visible: true },
      { id: 'education', type: 'education', title: 'Education', order: 3, visible: true },
      { id: 'skills', type: 'skills', title: 'Skills', order: 4, visible: true },
    ],
    templateId: backendResume.templateId,
    templateSettings: backendResume.templateSettings,
    isArchived: backendResume.isArchived,
    lastATSScore: backendResume.lastATSScore ?? null,
    variants: backendResume.variants?.map((variant) => ({
      id: variant.id,
      resumeId: backendResume.id,
      name: variant.name,
      targetJob: variant.targetJob,
      createdAt: variant.createdAt,
    })),
  };
}

// Transform frontend Resume to backend format
function transformToBackend(resume: Partial<Resume>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  
  if (resume.name !== undefined) data.name = resume.name;
  if (resume.personalInfo !== undefined) data.personalInfo = resume.personalInfo;
  if (resume.summary !== undefined) data.summary = resume.summary;
  if (resume.experience !== undefined) data.experience = resume.experience;
  if (resume.education !== undefined) data.education = resume.education;
  if (resume.skills !== undefined) {
    // Convert Skill[] to string[]
    data.skills = resume.skills.map(s => typeof s === 'string' ? s : s.name);
  }
  if (resume.sections !== undefined) data.sections = resume.sections;
  if (resume.templateId !== undefined) data.templateId = resume.templateId;
  if (resume.templateSettings !== undefined) data.templateSettings = resume.templateSettings;
  if (resume.isArchived !== undefined) data.isArchived = resume.isArchived;
  
  return data;
}

export const resumeApi = {
  /**
   * Get all resumes for current user
   */
  async getAll(): Promise<Resume[]> {
    const resumes = await apiClient.get<BackendResume[]>('/resumes');
    return resumes.map(transformResume);
  },

  /**
   * Get a single resume by ID
   */
  async getById(id: string): Promise<Resume> {
    const resume = await apiClient.get<BackendResume>(`/resumes/${id}`);
    return transformResume(resume);
  },

  /**
   * Create a new resume
   */
  async create(data: Partial<Resume>): Promise<Resume> {
    const backendData = transformToBackend(data);
    const resume = await apiClient.post<BackendResume>('/resumes', backendData);
    return transformResume(resume);
  },

  /**
   * Update an existing resume
   */
  async update(id: string, data: Partial<Resume>): Promise<Resume> {
    const backendData = transformToBackend(data);
    const resume = await apiClient.put<BackendResume>(`/resumes/${id}`, backendData);
    return transformResume(resume);
  },

  /**
   * Partially update an existing resume
   */
  async patch(id: string, data: Partial<Resume>): Promise<Resume> {
    const backendData = transformToBackend(data);
    const resume = await apiClient.patch<BackendResume>(`/resumes/${id}`, backendData);
    return transformResume(resume);
  },

  /**
   * Delete a resume
   */
  async delete(id: string): Promise<void> {
    await apiClient.delete(`/resumes/${id}`);
  },

  /**
   * Upload and parse a resume file (PDF/DOCX)
   */
  async uploadFile(file: File): Promise<Resume> {
    const resume = await apiClient.upload<BackendResume>('/resumes/upload', file);
    return transformResume(resume);
  },

  /**
   * Fetch the original uploaded file (PDF/DOCX) for a resume, as a blob URL.
   * Returns null if no original file is stored.
   */
  async getOriginalFileUrl(id: string): Promise<string | null> {
    try {
      const blob = await apiClient.download(`/resumes/${id}/original`);
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  },

  /**
   * Create a resume variant (tailored version)
   */
  async createVariant(resumeId: string, name: string, targetJob?: string): Promise<ResumeVariant> {
    const variant = await apiClient.post<BackendVariant>(
      `/resumes/${resumeId}/variants`,
      { name, targetJob }
    );
    return {
      id: variant.id,
      resumeId,
      name: variant.name,
      targetJob: variant.targetJob,
      createdAt: variant.createdAt,
    };
  },

  /**
   * Get all variants for a resume
   */
  async getVariants(resumeId: string): Promise<ResumeVariant[]> {
    const variants = await apiClient.get<BackendVariant[]>(`/resumes/${resumeId}/variants`);
    return variants.map((variant) => ({
      id: variant.id,
      resumeId,
      name: variant.name,
      targetJob: variant.targetJob,
      createdAt: variant.createdAt,
    }));
  },

  /**
   * Delete a variant
   */
  async deleteVariant(resumeId: string, variantId: string): Promise<void> {
    await apiClient.delete(`/resumes/${resumeId}/variants/${variantId}`);
  },

  /**
   * Archive a resume
   */
  async archive(id: string): Promise<Resume> {
    const resume = await apiClient.patch<BackendResume>(`/resumes/${id}/archive`);
    return transformResume(resume);
  },

  /**
   * Unarchive a resume
   */
  async unarchive(id: string): Promise<Resume> {
    const resume = await apiClient.patch<BackendResume>(`/resumes/${id}/unarchive`);
    return transformResume(resume);
  },

  /**
   * Export resume as PDF
   */
  async exportPdf(id: string): Promise<Blob> {
    return apiClient.download(`/resumes/${id}/export/pdf`);
  },

  /**
   * Export resume as DOCX
   */
  async exportDocx(id: string): Promise<Blob> {
    return apiClient.download(`/resumes/${id}/export/docx`);
  },

  /**
   * Export dynamic form data directly to DOCX (no saved resume required)
   * Uses the template-based generation with placeholder replacement
   */
  async exportDynamicDocx(templateId: string, sections: DynamicResumeData['sections']): Promise<Blob> {
    return apiClient.downloadPost('/resumes/export/docx-preview', {
      templateId,
      sections,
    });
  },

  /**
   * Export dynamic form data directly to PDF (no saved resume required)
   * Uses HTML-to-PDF generation via Puppeteer
   */
  async exportDynamicPdf(sections: DynamicResumeData['sections']): Promise<Blob> {
    return apiClient.downloadPost('/resumes/export/pdf-preview', {
      sections,
    });
  },

  /**
   * Export the currently rendered resume preview to PDF.
   */
  async exportRenderedPdf(documentName: string, html: string): Promise<Blob> {
    return apiClient.downloadPost('/export/html-to-pdf', {
      documentName,
      html,
    });
  },

  /**
   * Export the currently rendered resume preview to DOCX.
   */
  async exportRenderedDocx(documentName: string, html: string): Promise<Blob> {
    return apiClient.downloadPost('/export/html-to-docx', {
      documentName,
      html,
    });
  },
};

// Raw uploaded files (PDF/DOCX/TXT) - stored for Job Match only, never parsed
// into builder resumes and never shown in "My Resumes".
export interface UploadedFileSummary {
  id: string;
  fileName: string;
  fileType: string;
  createdAt: string;
}

export const uploadedFilesApi = {
  async upload(file: File): Promise<UploadedFileSummary> {
    const fileData = await apiClient.upload<{ id: string; fileName: string; fileType: string; createdAt: string }>(
      '/uploaded-files',
      file
    );
    return fileData;
  },

  async list(): Promise<UploadedFileSummary[]> {
    const data = await apiClient.get<{ files: UploadedFileSummary[] }>('/uploaded-files');
    return data.files;
  },
};
