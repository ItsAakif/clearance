// ATS API service - connected to Clearance backend
// All scoring/analysis logic comes from the backend

import type { ATSReport, ATSCategoryScore, JobMatch, LLMEvaluation } from "@/types/ats";
import { apiClient } from "./client";

// Backend response types
interface BackendATSReport {
  id: string;
  resumeId: string | null;
  overallScore: number;
  status: "excellent" | "good" | "needs-work" | "poor";
  createdAt: string;
  categories: ATSCategoryScore[];
  keywords: {
    found: string[];
    missing: string[];
  };
  formatting: {
    isAtsCompatible: boolean;
    issues: string[];
  };
  evaluationJson?: LLMEvaluation | null;
  scoredBy?: "llm" | "rules";
}

interface BackendJobMatch {
  id: string;
  resumeId: string;
  jobDescription: string;
  jobTitle?: string;
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  suggestions: string[];
  createdAt: string;
}

// Transform backend report to frontend type
function transformReport(backendReport: BackendATSReport): ATSReport {
  return {
    id: backendReport.id,
    resumeId: backendReport.resumeId || '',
    overallScore: backendReport.overallScore,
    status: backendReport.status,
    createdAt: backendReport.createdAt,
    categories: backendReport.categories || [],
    keywords: backendReport.keywords || { found: [], missing: [] },
    formatting: backendReport.formatting || { isAtsCompatible: true, issues: [] },
    evaluationJson: backendReport.evaluationJson ?? null,
    scoredBy: backendReport.scoredBy ?? 'rules',
  };
}

// Transform backend job match to frontend type
function transformJobMatch(backendMatch: BackendJobMatch): JobMatch {
  return {
    id: backendMatch.id,
    resumeId: backendMatch.resumeId,
    jobDescription: backendMatch.jobDescription,
    matchScore: backendMatch.matchScore,
    matchedKeywords: backendMatch.matchedKeywords,
    missingKeywords: backendMatch.missingKeywords,
    suggestions: backendMatch.suggestions,
    createdAt: backendMatch.createdAt,
  };
}

export const atsApi = {
  /**
   * Scan a resume for ATS compatibility
   * Returns a detailed report with scores and suggestions
   */
  async scanResume(resumeId: string): Promise<ATSReport> {
    const report = await apiClient.post<BackendATSReport>(`/ats/scan/${resumeId}`);
    return transformReport(report);
  },

  /**
   * Scan an uploaded file (public, no auth required)
   * For landing page scanner
   */
  async scanResumePublic(file: File): Promise<ATSReport> {
    const report = await apiClient.upload<BackendATSReport>('/ats/scan-public', file);
    return transformReport(report);
  },

  /**
   * Get a specific ATS report by ID
   */
  async getReport(reportId: string): Promise<ATSReport> {
    const report = await apiClient.get<BackendATSReport>(`/ats/reports/${reportId}`);
    return transformReport(report);
  },

  /**
   * Get all ATS reports for a resume
   */
  async getReportsForResume(resumeId: string): Promise<ATSReport[]> {
    const reports = await apiClient.get<BackendATSReport[]>(`/resumes/${resumeId}/ats-reports`);
    return reports.map(transformReport);
  },

  /**
   * Match a resume (or raw uploaded file) against a job description
   * Returns match score and keyword analysis
   */
  async matchJob(
    params: { resumeId?: string; uploadedFileId?: string },
    jobDescription: string
  ): Promise<JobMatch> {
    const match = await apiClient.post<BackendJobMatch>('/job-match', {
      resumeId: params.resumeId,
      uploadedFileId: params.uploadedFileId,
      jobDescription,
    });
    return transformJobMatch(match);
  },

  /**
   * Get a specific job match by ID
   */
  async getJobMatch(matchId: string): Promise<JobMatch> {
    const match = await apiClient.get<BackendJobMatch>(`/job-match/${matchId}`);
    return transformJobMatch(match);
  },

  /**
   * Build a tailored resume from a job description. When resumeId is supplied,
   * the draft is based on the user's real resume, reshaped toward the JD.
   */
  async buildFromJd(payload: {
    jobDescription: string;
    resumeId?: string;
    name?: string;
    fullName?: string;
    email?: string;
    phone?: string;
    location?: string;
  }): Promise<{ id: string; name: string }> {
    const result = await apiClient.post<{ id: string; name: string }>('/ai/build-from-jd', payload);
    return result;
  },

  /**
   * List all stored job match scans for the current user, newest first.
   */
  async listJobMatches(): Promise<SavedJobMatchSummary[]> {
    const data = await apiClient.get<{ matches: SavedJobMatchSummary[] }>('/job-match');
    return data.matches;
  },

  /**
   * List the current user's saved ATS scans (history), newest first.
   */
  async getSavedScans(): Promise<SavedScanSummary[]> {
    const scans = await apiClient.get<SavedScanSummary[]>('/ats/scans');
    return scans;
  },
};

// Summary of a saved scan for history lists
export interface SavedScanSummary {
  id: string;
  resumeId: string | null;
  overallScore: number;
  status: "excellent" | "good" | "needs-work" | "poor";
  createdAt: string;
  scoredBy?: "llm" | "rules";
  isPublicScan: boolean;
  fileName?: string | null;
}

// Summary of a stored job match scan for history lists
export interface SavedJobMatchSummary {
  id: string;
  resumeId: string | null;
  jobTitle: string | null;
  detectedRole: string | null;
  matchScore: number;
  createdAt: string;
}
