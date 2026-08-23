// React Query hooks for ATS API
// Provides ATS scanning and job matching functionality

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { atsApi } from '@/services/api';
import type { ATSReport, JobMatch } from '@/types/ats';
import { toast } from './use-toast';
import { resumeKeys } from './useResumeApi';

// Query keys
export const atsKeys = {
  all: ['ats'] as const,
  reports: () => [...atsKeys.all, 'reports'] as const,
  report: (id: string) => [...atsKeys.reports(), id] as const,
  resumeReports: (resumeId: string) => [...atsKeys.reports(), 'resume', resumeId] as const,
  matches: () => [...atsKeys.all, 'matches'] as const,
  match: (id: string) => [...atsKeys.matches(), id] as const,
};

/**
 * Get a specific ATS report
 */
export function useATSReport(reportId: string | undefined) {
  return useQuery({
    queryKey: atsKeys.report(reportId || ''),
    queryFn: () => atsApi.getReport(reportId!),
    enabled: !!reportId,
    staleTime: 1000 * 60 * 30, // 30 minutes (reports don't change)
  });
}

/**
 * Get all ATS reports for a resume
 */
export function useResumeATSReports(resumeId: string | undefined) {
  return useQuery({
    queryKey: atsKeys.resumeReports(resumeId || ''),
    queryFn: () => atsApi.getReportsForResume(resumeId!),
    enabled: !!resumeId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Scan a resume for ATS compatibility
 */
export function useScanResume() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (resumeId: string) => atsApi.scanResume(resumeId),
    onSuccess: (report) => {
      // Cache the report
      queryClient.setQueryData(atsKeys.report(report.id), report);
      // Invalidate resume reports list
      queryClient.invalidateQueries({ queryKey: atsKeys.resumeReports(report.resumeId) });
      // Invalidate resume to update lastATSScore
      queryClient.invalidateQueries({ queryKey: resumeKeys.detail(report.resumeId) });
      
      const statusMessages: Record<string, string> = {
        'excellent': 'Excellent! Your resume is highly ATS-optimized.',
        'good': 'Good job! Your resume should pass most ATS systems.',
        'needs-work': 'Your resume needs some improvements for ATS.',
        'poor': 'Your resume may struggle with ATS systems.',
      };
      
      toast({
        title: `ATS Score: ${report.overallScore}/100`,
        description: statusMessages[report.status] || 'Scan complete.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Scan failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Scan an uploaded file (public, no auth)
 */
export function useScanResumePublic() {
  return useMutation({
    mutationFn: (file: File) => atsApi.scanResumePublic(file),
    onError: (error: Error) => {
      toast({
        title: 'Scan failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Get a specific job match
 */
export function useJobMatch(matchId: string | undefined) {
  return useQuery({
    queryKey: atsKeys.match(matchId || ''),
    queryFn: () => atsApi.getJobMatch(matchId!),
    enabled: !!matchId,
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
}

/**
 * Match resume against job description
 */
export function useMatchJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ resumeId, jobDescription }: { resumeId: string; jobDescription: string }) =>
      atsApi.matchJob({ resumeId }, jobDescription),
    onSuccess: (match) => {
      // Cache the match
      queryClient.setQueryData(atsKeys.match(match.id), match);
      
      const scoreMessage = match.matchScore >= 70 
        ? 'Great match for this role!' 
        : match.matchScore >= 50 
          ? 'Moderate match - consider adding missing keywords.'
          : 'Low match - significant customization recommended.';
      
      toast({
        title: `Match Score: ${match.matchScore}%`,
        description: scoreMessage,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Matching failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}
