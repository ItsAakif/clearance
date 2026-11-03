// Resume API service - connected to Clearance backend

// T1110: `DynamicResumeData` is gone from this list - the two `exportDynamic*` methods that
// were its only use in this file had no callers and were removed with the builder.
import type { Resume, ResumeVariant, PersonalInfo, ExperienceItem, EducationItem, ResumeSection, Skill } from "@/types/resume";
import { apiClient, ApiClientError } from "./client";

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
  /** T1101: `lastATSScore` is no longer declared here at all. The backend still sends it and
 *  `routes/ats.ts` still writes it as an internal signal, but a client type that does not name a
 *  member cannot hand it to a component - so the column has no path to a screen, which is
 *  stronger than remembering not to render it. */
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
    // T1101: `lastATSScore` is NOT mapped onto the client type. The column is still written by
    // `routes/ats.ts` as an internal signal; it is not carried into the browser, so no component
    // can render it even by accident.
    variants: backendResume.variants?.map((variant) => ({
      id: variant.id,
      resumeId: backendResume.id,
      name: variant.name,
      targetJob: variant.targetJob,
      createdAt: variant.createdAt,
    })),
  };
}

// Write payload for create/update/patch. The editor shape (ResumeData) carries
// skills as plain names (string[]); the stored Resume shape carries Skill[].
// The wire format is string[] either way and transformToBackend already
// normalizes both, so the input type admits both. Runtime behaviour unchanged.
export type ResumeWritePayload = Partial<Omit<Resume, 'skills'>> & {
  skills?: Skill[] | string[];
};

// Transform frontend Resume to backend format
function transformToBackend(resume: ResumeWritePayload): Record<string, unknown> {
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
  async create(data: ResumeWritePayload): Promise<Resume> {
    const backendData = transformToBackend(data);
    const resume = await apiClient.post<BackendResume>('/resumes', backendData);
    return transformResume(resume);
  },

  /**
   * Update an existing resume
   */
  async update(id: string, data: ResumeWritePayload): Promise<Resume> {
    const backendData = transformToBackend(data);
    const resume = await apiClient.put<BackendResume>(`/resumes/${id}`, backendData);
    return transformResume(resume);
  },

  /**
   * Partially update an existing resume
   */
  async patch(id: string, data: ResumeWritePayload): Promise<Resume> {
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

  // T1110: `exportDynamicDocx` and `exportDynamicPdf` are REMOVED. Their only reason to exist
  // was to export a `DynamicResumeData` shape straight to the preview endpoints, and the only
  // caller of either was the deleted builder tree - a repo-wide search for both names returns
  // zero call sites. They were the last live reference to `DynamicResumeData` in this file, so
  // removing them is what let `src/types/resume.ts` lose that whole family (A-30/A-33).
  // The backend endpoints they called are NOT touched: they live in the frozen
  // `routes/resume.ts` (A-42/A-43), whose retirement is the backend half of the cutover.

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

// Raw uploaded files (PDF/DOCX/TXT) - stored as-is, listed in My Resumes >
// Uploaded and matched raw. Never parsed into builder resumes and never
// rendered through a builder template.
export interface UploadedFileSummary {
  id: string;
  fileName: string;
  fileType: string;
  createdAt: string;
}

async function getUploadedFileBlob(fileId: string): Promise<Blob> {
  // apiClient.download throws ApiClientError (with statusCode) on 401/403/404.
  // Do not swallow it: callers surface the status in the preview error state.
  const blob = await apiClient.download(`/uploaded-files/${fileId}/view`);
  if (blob.size === 0) {
    // A 200 with zero bytes would render as a blank iframe; fail loudly so
    // the preview shows an explicit empty-file message instead.
    throw new ApiClientError(
      'The stored file is empty (0 bytes). Re-upload the file.',
      422
    );
  }
  return blob;
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

  async getBlob(fileId: string): Promise<Blob> {
    return getUploadedFileBlob(fileId);
  },

  // Caller owns URL.revokeObjectURL for the returned blob: URL.
  async viewUrl(fileId: string): Promise<string> {
    return URL.createObjectURL(await getUploadedFileBlob(fileId));
  },

  async download(fileId: string): Promise<Blob> {
    return apiClient.download(`/uploaded-files/${fileId}`);
  },

  async getText(fileId: string): Promise<{ text: string; truncated: boolean }> {
    return apiClient.get<{ text: string; truncated: boolean }>(`/uploaded-files/${fileId}/text`);
  },
};
