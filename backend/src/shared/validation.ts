// Shared validation schemas using Zod
// All user input must be validated on the backend per security.md

import { z } from 'zod';
import { BadRequestError } from './errors.js';

// ==================== AUTH SCHEMAS ====================
export const accessPasswordSchema = z.object({
  password: z.string().min(1, 'Password is required').max(200, 'Password too long'),
}).strict();

export const updateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').optional(),
  avatarUrl: z.string().url('Invalid URL').max(500).optional().nullable(),
});

// ==================== RESUME SCHEMAS ====================
export const personalInfoSchema = z.object({
  fullName: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  email: z.string().email('Invalid email format').max(255),
  phone: z.string().max(30, 'Phone number too long').regex(/^[\d\s\-\+\(\)\.]*$/, 'Invalid phone format'),
  location: z.string().max(100, 'Location too long'),
  linkedin: z.string().max(200).optional().nullable(),
  website: z.string().max(200).optional().nullable(),
});

export const experienceItemSchema = z.object({
  id: z.string(),
  title: z.string().max(100, 'Title too long'),
  company: z.string().max(100, 'Company name too long'),
  startDate: z.string().max(20),
  endDate: z.string().max(20),
  description: z.string().max(1000).optional().default(''),
  bullets: z.array(z.string().max(500, 'Bullet point too long')).max(10, 'Too many bullet points'),
});

export const educationItemSchema = z.object({
  id: z.string(),
  degree: z.string().max(100, 'Degree name too long'),
  institution: z.string().max(100, 'Institution name too long'),
  field: z.string().max(100, 'Field of study too long'),
  graduationYear: z.string().max(10),
});

export const resumeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  personalInfo: personalInfoSchema,
  summary: z.string().max(2000, 'Summary too long'),
  experience: z.array(experienceItemSchema).max(20, 'Too many experience entries'),
  education: z.array(educationItemSchema).max(10, 'Too many education entries'),
  skills: z.array(z.string().max(50, 'Skill name too long')).max(50, 'Too many skills'),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string().max(100),
    description: z.string().max(1000),
    url: z.string().max(200).optional(),
    technologies: z.array(z.string().max(50)).max(10),
  })).max(10).optional(),
  templateId: z.string().max(50).optional(),
  templateSettings: z.object({
    marginX: z.number().min(0.5).max(1.5),
    marginY: z.number().min(0.5).max(1.5),
    fontSize: z.number().min(8).max(16),
    lineSpacing: z.number().min(1).max(2),
    sectionSpacing: z.number().min(0.5).max(3),
  }).optional(),
  sections: z.array(z.object({
    id: z.string(),
    type: z.enum(['personal', 'summary', 'experience', 'education', 'skills', 'projects', 'custom']),
    title: z.string().max(50),
    order: z.number(),
    visible: z.boolean(),
  })).max(10).optional(),
});

export const createResumeSchema = resumeSchema.partial().extend({
  name: z.string().min(1).max(100).optional().default('Untitled Resume'),
});

export const updateResumeSchema = resumeSchema.partial();

export const createVariantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  targetJob: z.string().max(100).optional(),
});

// ==================== ATS SCHEMAS ====================
export const scanResumeSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID'),
});

export const publicScanSchema = z.object({
  // For file upload, validated separately
});

// ==================== JOB MATCH SCHEMAS ====================
export const jobMatchSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID').optional(),
  uploadedFileId: z.string().uuid('Invalid uploaded file ID').optional(),
  jobDescription: z.string()
    .min(50, 'Job description too short')
    .max(10000, 'Job description too long'),
}).refine((data) => data.resumeId || data.uploadedFileId, {
  message: 'Either resumeId or uploadedFileId is required',
});

// ==================== API KEY (BYOK) SCHEMAS ====================
export const apiKeyProviderSchema = z.enum(['openai', 'groq', 'openrouter', 'gemini', 'tavily', 'exa', 'firecrawl', 'crawl4ai', 'rapidapi', 'adzuna', 'jooble', 'careerjet']);
export const createApiKeySchema = z.object({
  provider: apiKeyProviderSchema,
  apiKey: z.string().min(8, 'API key too short').max(500, 'API key too long'),
  label: z.string().max(50, 'Label too long').optional(),
});

// ==================== JOB DISCOVERY SCHEMAS ====================
export const jobSearchSchema = z.object({
  q: z.string().min(2, 'Query too short').max(200, 'Query too long'),
  sources: z.array(z.enum(['greenhouse', 'ashby', 'lever', 'workday', 'rss'])).max(5).optional(),
  limit: z.number().int().min(1).max(100).optional().default(30),
});

export const evaluateJobSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID'),
  jobDescription: z.string().min(50, 'Job description too short').max(20000, 'Job description too long'),
});

export const tailorResumeSchema = z.object({
  jobEvaluationId: z.string().uuid().optional(),
  jobDescription: z.string().min(50, 'Job description too short').max(20000).optional(),
  resumeId: z.string().uuid('Invalid resume ID'),
  templateId: z.string().min(1, 'Template is required').max(50),
  jobListingId: z.string().uuid().optional(),
}).refine(
  (data) => data.jobEvaluationId || data.jobDescription,
  { message: 'Provide either jobEvaluationId or jobDescription' },
);

export const createApplicationSchema = z.object({
  jobListingId: z.string().uuid('Invalid job listing ID'),
  tailoredResumeId: z.string().uuid().optional(),
  status: z.enum(['saved', 'tailored', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted']).default('saved'),
  notes: z.string().max(2000).optional(),
});

export const updateApplicationSchema = z.object({
  status: z.enum(['saved', 'tailored', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted']).optional(),
  notes: z.string().max(2000).optional(),
  appliedAt: z.string().datetime().optional(),
  followUpAt: z.string().datetime().nullable().optional(),
  ghostedAt: z.string().datetime().nullable().optional(),
  withdrawnAt: z.string().datetime().nullable().optional(),
});

// ==================== APPLICATION EVENT SCHEMAS ====================
export const applicationEventTypeSchema = z.enum([
  'status_change', 'note_added', 'follow_up', 'interview_scheduled', 'offer_received', 'rejected', 'withdrawn',
]);

export const createApplicationEventSchema = z.object({
  type: applicationEventTypeSchema,
  fromStatus: z.string().max(50).optional(),
  toStatus: z.string().max(50).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

export const updateApplicationEventSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

// ==================== CAREER PROFILE SCHEMAS ====================
export const seniorityEnum = z.enum(['junior', 'mid', 'senior', 'staff', 'lead', 'principal']);

export const careerProfileSchema = z.object({
  targetRoles: z.array(z.string().max(100, 'Target role too long')).max(10, 'Too many target roles').optional(),
  seniority: seniorityEnum.optional(),
  minSalary: z.number().int().min(0).max(10000000).optional(),
  maxSalary: z.number().int().min(0).max(10000000).optional(),
  currency: z.string().max(5).optional(),
  locationPref: z.string().max(100, 'Location too long').optional(),
  remoteOnly: z.boolean().optional(),
  topSkills: z.array(z.string().max(50, 'Skill too long')).max(50, 'Too many skills').optional(),
  industries: z.array(z.string().max(50)).max(30).optional(),
  redFlags: z.array(z.string().max(50)).max(30).optional(),
  proofPoints: z.array(z.string().max(500)).max(30).optional(),
  summary: z.string().max(2000, 'Summary too long').optional(),
  parsedFromResumeId: z.string().max(100).optional(),
}).strict();

export function computeProfileComplete(data: Partial<z.infer<typeof careerProfileSchema>>): boolean {
  return (
    Array.isArray(data.targetRoles) &&
    data.targetRoles.length > 0 &&
    !!data.seniority &&
    Array.isArray(data.topSkills) &&
    data.topSkills.length > 0
  );
}

export const parseProfileSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID'),
});

// ==================== JOB BOARD SCHEMAS ====================
export const jobBoardCreateSchema = z.object({
  type: z.enum(['greenhouse', 'ashby', 'lever', 'workday', 'rss']),
  name: z.string().min(1, 'Name required').max(100),
  boardId: z.string().max(200).optional(),
  feedUrl: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
});

export const jobBoardUpdateSchema = jobBoardCreateSchema.partial();

// ==================== SAVED SEARCH SCHEMAS ====================
export const savedSearchCreateSchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  query: z.string().min(1).max(200),
  location: z.string().max(100).optional(),
  company: z.string().max(100).optional(),
  boards: z.array(z.string()).max(10).optional(),
});

export const savedSearchUpdateSchema = savedSearchCreateSchema.partial();

// Score a resume against a job description using the 3-factor ATS scorer.
export const scoreJobSchema = z.object({
  resumeId: z.string().min(1),
  jobDescription: z.string().min(1),
});

// ==================== JOB ALERT SCHEMAS ====================
export const createJobAlertSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  query: z.string().min(1, 'Query is required').max(500, 'Query too long'),
  location: z.string().max(100).optional().nullable(),
  sources: z.array(z.string()).max(20).optional().nullable(),
  savedSearchId: z.string().optional().nullable(),
  minMatchScore: z.number().int().min(0).max(100).optional().nullable(),
  remoteOnly: z.boolean().optional(),
  isActive: z.boolean().optional(),
  notifyInApp: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
});

export const updateJobAlertSchema = createJobAlertSchema.partial();

// ==================== QUESTION ANSWER SCHEMAS ====================
export const createQuestionAnswerSchema = z.object({
  question: z.string().min(1, 'Question is required').max(2000, 'Question too long'),
  answer: z.string().min(1, 'Answer is required').max(5000, 'Answer too long'),
  category: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).optional().nullable(),
});

export const updateQuestionAnswerSchema = createQuestionAnswerSchema.partial();

// ==================== UTILITY FUNCTIONS ====================
export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ValidationError(`Validation failed: ${errors}`);
  }
  return result.data;
}

// Custom error for validation
export class ValidationError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Type exports
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ResumeInput = z.infer<typeof resumeSchema>;
export type CreateResumeInput = z.infer<typeof createResumeSchema>;
export type UpdateResumeInput = z.infer<typeof updateResumeSchema>;
export type CreateVariantInput = z.infer<typeof createVariantSchema>;
export type JobMatchInput = z.infer<typeof jobMatchSchema>;
