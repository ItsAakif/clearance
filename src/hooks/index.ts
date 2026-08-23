// Central hooks exports
export { useResumeData } from './useResumeData';
export { useTemplateSettings } from './useTemplateSettings';
export { useToast, toast } from './use-toast';
export { useIsMobile } from './use-mobile';

// API hooks (React Query)
export {
  useResumes,
  useResume,
  useCreateResume,
  useUpdateResume,
  useDeleteResume,
  useUploadResume,
  useExportPdf,
  useExportDocx,
  resumeKeys,
} from './useResumeApi';

export {
  useCurrentUser,
  useAuth,
  useLogin,
  useSignup,
  useLogout,
  useCompletePasswordReset,
  useUpdateProfile,
  authKeys,
} from './useAuth';

export {
  useATSReport,
  useResumeATSReports,
  useScanResume,
  useScanResumePublic,
  useJobMatch,
  useMatchJob,
  atsKeys,
} from './useATS';
