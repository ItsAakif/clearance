// Display-only labels for curated skill keys. Wire values stay canonical.
const SKILL_LABELS: Record<string, string> = {
  'artificial intelligence': 'Artificial intelligence',
  'machine learning': 'Machine learning',
  'amazon web services': 'AWS',
  'google cloud platform': 'Google Cloud',
  postgresql: 'PostgreSQL',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  node: 'Node.js',
  react: 'React',
  kubernetes: 'Kubernetes',
  docker: 'Docker',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  sql: 'SQL',
  nosql: 'NoSQL',
  'ci/cd': 'CI/CD',
  graphql: 'GraphQL',
  terraform: 'Terraform',
  redis: 'Redis',
  mongodb: 'MongoDB',
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'GCP',
  llm: 'LLMs',
  nlp: 'NLP',
};

export function skillLabel(skill: string): string {
  const key = String(skill ?? '');
  if (Object.prototype.hasOwnProperty.call(SKILL_LABELS, key)) {
    return SKILL_LABELS[key];
  }
  // Deterministic fallback: capitalise the first character only.
  if (key.length === 0) return key;
  return key.charAt(0).toUpperCase() + key.slice(1);
}
