// Central hooks exports
//
// T1110: `useResumeData` (A-29) and `useTemplateSettings` (A-31) are gone with the legacy
// builder. Nothing in `src/` imported this barrel either way - every hook is imported from its
// own module - but the re-exports named deleted files, so `tsc` would have failed on a module
// that no longer exists.
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
  useLogout,
  useUpdateProfile,
  authKeys,
} from './useAuth';

// T1110: `hooks/useATS.ts` is GONE. Every one of its six hooks existed to fetch or produce an
// ATS score - and two of them fired a toast reading `ATS Score: 87/100` / `Match Score: 68%` -
// which is what 06 sec. E.6 forbids. The pages that used them (`ATSScan`, `ATSHistory`,
// `MatchLegacy`) are retired too. Nothing imported this barrel anyway: every hook in the repo is
// imported from its own module.
