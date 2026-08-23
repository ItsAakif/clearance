// ATS Report types for Clearance

export type IssueLevel = "good" | "warning" | "issue";

export interface ATSIssue {
  id: string;
  category: string;
  title: string;
  description: string;
  level: IssueLevel;
  suggestion?: string;
}

export interface ATSCategoryScore {
  category: string;
  score: number;
  maxScore: number;
  issues: ATSIssue[];
}

// LLM-based evaluation (ATS-native rubric)
export interface LLMCategoryScore {
  score: number;
  max: number;
  evidence: string;
}

export interface LLMEvaluation {
  categories: {
    parseability: LLMCategoryScore;
    keywords: LLMCategoryScore;
    actionVerbs: LLMCategoryScore;
    contactInfo: LLMCategoryScore;
    sectionCompleteness: LLMCategoryScore;
    experienceSignals: LLMCategoryScore;
  };
  bonusPoints: { total: number; breakdown: string };
  deductions: { total: number; reasons: string };
  overallScore: number;
  status: "excellent" | "good" | "needs-work" | "poor";
  keyStrengths: string[];
  areasForImprovement: string[];
  reasoning: string;
}

export interface ATSReport {
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
  // LLM evaluation payload (present when scoredBy === 'llm')
  evaluationJson?: LLMEvaluation | null;
  scoredBy?: "llm" | "rules";
}

export interface JobMatch {
  id: string;
  resumeId: string;
  jobDescription: string;
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  suggestions: string[];
  createdAt: string;
}
