// Role-specific ATS keyword banks.
// Used by the Job Match feature to surface *relevant* missing keywords (not just
// every unmatched job word). Mirrors how real ATS tailoring tools (Jobscan,
// Convertifyy) rank "critical" hard skills vs "preferred" nice-to-haves.
//
// These are suggestions only - never penalize a candidate for not matching a
// role they didn't select. The bank is matched against the resume so we only
// recommend skills the candidate plausibly has but didn't list.

export interface RoleKeywordBank {
  // Canonical keywords that, if present in the job description, are "critical".
  critical: string[];
  // Keywords that are "preferred / nice-to-have".
  preferred: string[];
  // Common aliases -> canonical form, for synonym matching.
  aliases?: Record<string, string>;
}

export const ROLE_KEYWORD_BANKS: Record<string, RoleKeywordBank> = {
  'software-engineer': {
    critical: [
      'javascript', 'typescript', 'react', 'node.js', 'python', 'java', 'go',
      'sql', 'rest', 'api', 'git', 'ci/cd', 'docker', 'kubernetes', 'aws',
      'system design', 'data structures', 'algorithms', 'testing',
    ],
    preferred: [
      'graphql', 'microservices', 'redis', 'postgresql', 'mongodb', 'terraform',
      'azure', 'gcp', 'next.js', 'vue', 'angular', 'grpc', 'kafka', 'observability',
    ],
  },
  'frontend-engineer': {
    critical: [
      'javascript', 'typescript', 'react', 'html', 'css', 'next.js', 'tailwind',
      'responsive design', 'accessibility', 'git', 'rest', 'api', 'testing',
    ],
    preferred: [
      'vue', 'angular', 'sass', 'webpack', 'graphql', 'redux', 'storybook',
      'performance optimization', 'jest', 'playwright',
    ],
  },
  'backend-engineer': {
    critical: [
      'node.js', 'python', 'java', 'go', 'sql', 'postgresql', 'rest', 'api',
      'microservices', 'docker', 'kubernetes', 'aws', 'redis', 'git', 'ci/cd',
    ],
    preferred: [
      'graphql', 'grpc', 'kafka', 'rabbitmq', 'mongodb', 'terraform', 'gcp',
      'azure', 'elasticsearch', 'caching',
    ],
  },
  'data-analyst': {
    critical: [
      'sql', 'python', 'excel', 'data visualization', 'tableau', 'power bi',
      'statistics', 'etl', 'reporting', 'data analysis',
    ],
    preferred: [
      'r', 'pandas', 'numpy', 'looker', 'snowflake', 'google analytics',
      'a/b testing', 'machine learning', 'spark', 'dax',
    ],
  },
  'data-scientist': {
    critical: [
      'python', 'machine learning', 'sql', 'statistics', 'pandas', 'numpy',
      'scikit-learn', 'data analysis', 'deep learning', 'nlp',
    ],
    preferred: [
      'tensorflow', 'pytorch', 'spark', 'r', 'tableau', 'power bi', 'aws',
      'feature engineering', 'experimentation',
    ],
  },
  'devops-engineer': {
    critical: [
      'aws', 'docker', 'kubernetes', 'terraform', 'ci/cd', 'linux', 'bash',
      'monitoring', 'prometheus', 'git', 'ansible',
    ],
    preferred: [
      'gcp', 'azure', 'helm', 'grafana', 'lambda', 'jenkins', 'github actions',
      'observability', 'iac',
    ],
  },
  'product-manager': {
    critical: [
      'product management', 'roadmap', 'user research', 'agile', 'scrum',
      'stakeholder management', 'analytics', 'a/b testing', 'sql', 'jira',
    ],
    preferred: [
      'okrs', 'kpis', 'go-to-market', 'wireframes', 'figma', 'sql', 'tableau',
      'data-driven', 'cross-functional',
    ],
  },
  'marketing': {
    critical: [
      'seo', 'content marketing', 'social media', 'google analytics', 'campaigns',
      'email marketing', 'copywriting', 'brand', 'crm',
    ],
    preferred: [
      'sem', 'ppc', 'hubspot', 'marketo', 'adwords', 'a/b testing', 'figma',
      'influencer marketing', 'marketing automation',
    ],
  },
};

// Soft / noise words that should never be recommended as missing "skills".
export const JOB_MATCH_NOISE = new Set([
  'year', 'years', 'year\'s', 'experience', 'team', 'teams', 'work', 'working',
  'ability', 'skills', 'skill', 'role', 'responsibilities', 'responsibility',
  'requirements', 'requirement', 'qualifications', 'qualification', 'degree',
  'bachelor', 'master', 'company', 'client', 'clients', 'project', 'projects',
  'day', 'days', 'time', 'strong', 'excellent', 'good', 'great', 'plus',
  'preferred', 'required', 'nice', 'bonus', 'etc', 'including', 'ability',
]);

/**
 * Detect the most likely role from a job description, used to pick a keyword bank.
 * Returns the bank key or null when no confident match.
 */
export function detectRoleFromJobDescription(jobDescription: string): string | null {
  const text = jobDescription.toLowerCase();
  const signals: Record<string, string[]> = {
    'frontend-engineer': ['frontend', 'front-end', 'front end', 'react developer', 'ui developer', 'css'],
    'backend-engineer': ['backend', 'back-end', 'back end', 'server-side', 'api developer'],
    'devops-engineer': ['devops', 'sre', 'site reliability', 'platform engineer', 'infrastructure'],
    'data-scientist': ['data scientist', 'machine learning engineer', 'ml engineer', 'deep learning'],
    'data-analyst': ['data analyst', 'business analyst', 'bi analyst', 'analytics'],
    'product-manager': ['product manager', 'product owner', 'product lead', 'pm '],
    'marketing': ['marketing', 'seo specialist', 'content strategist', 'growth marketer'],
    'software-engineer': ['software engineer', 'software developer', 'full stack', 'fullstack', 'full-stack'],
  };

  let best: { key: string; score: number } | null = null;
  for (const [key, terms] of Object.entries(signals)) {
    const score = terms.reduce((s, t) => (text.includes(t) ? s + 1 : s), 0);
    if (score > 0 && (!best || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
}

export function getRoleBank(roleKey: string | null): RoleKeywordBank | null {
  if (!roleKey) return null;
  return ROLE_KEYWORD_BANKS[roleKey] ?? null;
}
