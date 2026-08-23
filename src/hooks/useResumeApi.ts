// React Query hooks for Resume API
// Provides data fetching, caching, and mutations for resume operations

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { resumeApi } from '@/services/api';
import type { Resume } from '@/types/resume';
import { toast } from './use-toast';

// Query keys for cache management
export const resumeKeys = {
  all: ['resumes'] as const,
  lists: () => [...resumeKeys.all, 'list'] as const,
  list: () => [...resumeKeys.lists()] as const,
  details: () => [...resumeKeys.all, 'detail'] as const,
  detail: (id: string) => [...resumeKeys.details(), id] as const,
};

/**
 * Fetch all resumes for current user
 */
export function useResumes() {
  return useQuery({
    queryKey: resumeKeys.list(),
    queryFn: () => resumeApi.getAll(),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Fetch a single resume by ID
 */
export function useResume(id: string | undefined) {
  return useQuery({
    queryKey: resumeKeys.detail(id || ''),
    queryFn: () => resumeApi.getById(id!),
    enabled: !!id,
    staleTime: 1000 * 60 * 2, // 2 minutes
  });
}

/**
 * Create a new resume
 */
export function useCreateResume() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Resume>) => resumeApi.create(data),
    onSuccess: (newResume) => {
      // Add to cache
      queryClient.setQueryData(resumeKeys.detail(newResume.id), newResume);
      // Invalidate list to refetch
      queryClient.invalidateQueries({ queryKey: resumeKeys.lists() });
      
      toast({
        title: 'Resume created',
        description: `"${newResume.name}" has been created.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to create resume',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Update an existing resume
 */
export function useUpdateResume() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Resume> }) =>
      resumeApi.update(id, data),
    onSuccess: (updatedResume) => {
      // Update cache
      queryClient.setQueryData(resumeKeys.detail(updatedResume.id), updatedResume);
      // Invalidate list
      queryClient.invalidateQueries({ queryKey: resumeKeys.lists() });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to save changes',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Delete a resume
 */
export function useDeleteResume() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => resumeApi.delete(id),
    onSuccess: (_, deletedId) => {
      // Remove from cache
      queryClient.removeQueries({ queryKey: resumeKeys.detail(deletedId) });
      // Invalidate list
      queryClient.invalidateQueries({ queryKey: resumeKeys.lists() });
      
      toast({
        title: 'Resume deleted',
        description: 'The resume has been deleted.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to delete resume',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Upload and parse a resume file
 */
export function useUploadResume() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (file: File) => resumeApi.uploadFile(file),
    onSuccess: (newResume) => {
      // Add to cache
      queryClient.setQueryData(resumeKeys.detail(newResume.id), newResume);
      // Invalidate list
      queryClient.invalidateQueries({ queryKey: resumeKeys.lists() });
      
      toast({
        title: 'Resume uploaded',
        description: `"${newResume.name}" has been parsed and created.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to upload resume',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Export resume as PDF
 */
export function useExportPdf() {
  return useMutation({
    mutationFn: async (id: string) => {
      const blob = await resumeApi.exportPdf(id);
      // Trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'resume.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast({
        title: 'PDF exported',
        description: 'Your resume has been downloaded as PDF.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Export failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

/**
 * Export resume as DOCX
 */
export function useExportDocx() {
  return useMutation({
    mutationFn: async (id: string) => {
      const blob = await resumeApi.exportDocx(id);
      // Trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'resume.docx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast({
        title: 'DOCX exported',
        description: 'Your resume has been downloaded as DOCX.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Export failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}
