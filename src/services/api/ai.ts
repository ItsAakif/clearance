// AI API services - interview answer generation and other AI operations.
import { apiClient } from './client';

export type InterviewAnswerCategory = 'behavioral' | 'technical' | 'situational' | 'general';

export interface GenerateInterviewAnswerInput {
  question: string;
  category?: InterviewAnswerCategory;
  jobListingId?: string;
}

export interface GenerateInterviewAnswerResponse {
  answer: string;
}

export const aiApi = {
  generateInterviewAnswer: (payload: GenerateInterviewAnswerInput) =>
    apiClient.post<GenerateInterviewAnswerResponse>('/ai/generate-interview-answer', payload),
};
