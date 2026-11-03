// Seed the owner's real CV into the live V2 career model and create one master resume.
//
// Run: cd backend && npx tsx scripts/seed-aakif.ts
//
// Idempotent by construction:
//   - entities are matched on their natural key (company+title, institution+degree,
//     project name, skill normalized name, certification name) and updated in place;
//   - claims are created through career/claims#createClaim, whose
//     (profileId, fingerprint) uniqueness makes re-seeding a no-op;
//   - every owner claim is confirmed through career/verification#confirmClaim, which
//     writes its ClaimVerification audit row only once;
//   - the master resume is reused by name, and a revision is written only when the
//     projection differs from the current one.
//
// Sample fixtures are removed first. The contract names the two experience fixtures;
// the same fixture set also left sample education/project/certification/skill rows behind
// (University of London, LedgerKit, Analytical Engine Notes, Postgres/kubernetes), and the
// old sample summary claim is the earliest soft_skill claim the projector would otherwise
// place instead of the owner's summary. Those are removed too so the career record and the
// rendered resume contain the owner's CV rather than the sample profile.

import {
  ClaimKind,
  ClaimProvenance,
  ClaimStatus,
  EvidenceKind,
  PrismaClient,
  ResumeChangeSource,
} from '@prisma/client';
import {
  createCareerEntity,
  deleteCareerEntity,
  normalizeSkillName,
  updateCareerEntity,
  attachClaimToEntity,
  detachClaimFromEntity,
  type CareerEntityKind,
} from '../src/career/entities.js';
import { createClaim, type CareerClaimRow } from '../src/career/claims.js';
import { confirmClaim, reopenClaim } from '../src/career/verification.js';
import { createEvidenceSource } from '../src/career/evidence.js';
import {
  loadProjectionInput,
  projectResumeJson,
  type ProjectionBasics,
} from '../src/resume/json/project.js';
import { validateResumeJson } from '../src/resume/json/validate.js';
import { canonicalJsonHash } from '../src/resume/json/jsonresume.js';
import { createRevision, getCurrentRevision } from '../src/resume/revisions.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5543/clearance?schema=public';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const OWNER = {
  name: 'Aakif MoulaSaheb Mudel',
  email: 'aakifmudel@gmail.com',
  phone: '+91 9322668584',
  website: 'https://aakifmudel.xyz',
  github: 'github.com/itsaakif',
  linkedin: 'linkedin.com/in/aakifmudel',
  location: 'Solapur, Maharashtra, India',
  headline: 'Software Engineer',
  summary:
    'Software engineer with 6 months of production experience at JazarTech, shipping 8 enterprise products across ERP, logistics, fintech, and mobile. Build AI applications, Python backends, and full-stack systems using Python/FastAPI, React/TypeScript, PostgreSQL, RAG, embeddings, and local LLM inference. Projects span document intelligence, model evaluation, desktop AI, and production web systems, with measurable results in adoption, latency, memory, and benchmark performance.',
} as const;

const CLAIM_MARKER = 'owner_cv_seed';
const RESUME_NAME = 'Aakif Mudel - Master CV';
const TEMPLATE_ID = 'latex-medium-professional';

interface SkillGroup {
  category: string;
  skills: string[];
}

const SKILL_GROUPS: SkillGroup[] = [
  { category: 'Languages', skills: ['Python', 'TypeScript', 'JavaScript', 'Rust', 'SQL'] },
  {
    category: 'AI / ML',
    skills: [
      'LLMs',
      'Generative AI',
      'RAG',
      'Embeddings',
      'Vector Search',
      'Hybrid Retrieval',
      'Reranking',
      'NLP',
      'Document Intelligence',
      'OCR',
      'AI Agents',
      'Tool Use',
      'Model Evaluation',
      'Model Inference',
      'Prompt Engineering',
      'PyTorch',
      'scikit-learn',
      'Hugging Face Transformers',
      'ONNX Runtime',
      'Whisper.cpp',
      'Parakeet',
      'Silero VAD',
    ],
  },
  {
    category: 'Backend',
    skills: [
      'FastAPI',
      'Flask',
      'Django',
      'Node.js',
      'Express',
      'Async Python',
      'REST APIs',
      'OpenAPI',
      'Pydantic',
      'PostgreSQL',
      'SQLite',
      'pgvector',
      'Redis',
      'Celery',
      'SQLAlchemy',
      'Alembic',
      'Webhooks',
      'JWT',
      'RBAC',
      'Prisma',
      'Drizzle ORM',
    ],
  },
  {
    category: 'Frontend',
    skills: ['React', 'Next.js', 'React Native', 'TypeScript', 'Tailwind CSS', 'Vite'],
  },
  {
    category: 'Tools / Cloud',
    skills: [
      'LangChain',
      'LangGraph',
      'llama.cpp',
      'OpenAI API',
      'Gemini API',
      'Groq',
      'Supabase',
      'Firebase',
      'Stripe',
      'Docker',
      'Docker Compose',
      'Git',
      'Linux',
      'AWS',
      'GCP',
      'pytest',
      'Unit Testing',
      'Integration Testing',
      'API Testing',
      'Security Testing',
    ],
  },
];

const SPOKEN_LANGUAGES = ['English', 'Hindi', 'Marathi', 'Urdu'];
const SPOKEN_GROUP = 'Languages (spoken)';
const GROUP_SKILL_NAMES = [...SKILL_GROUPS.map((group) => group.category), SPOKEN_GROUP];
const GROUP_SKILL_NORMALS = GROUP_SKILL_NAMES.map((name) => normalizeSkillName(name));

interface ProjectSeed {
  name: string;
  tech: string[];
  bullets: string[];
}

const PROJECTS: ProjectSeed[] = [
  {
    name: 'TrashTheTest - AI Study Automation',
    tech: ['Python', 'FastAPI', 'React', 'PostgreSQL', 'pgvector', 'LangGraph'],
    bullets: [
      'Engineered a 21-route FastAPI document intelligence platform that converts academic PDFs into notes, flashcards, MCQs, answers, explanations, and citations using RAG, embeddings, hybrid retrieval, reranking, and LLM generation.',
      'Implemented 1024-dimensional Qwen3-Embedding-0.6B embeddings, pgvector HNSW search, PostgreSQL full-text search, RRF ranking, BGE reranking, citation validation, JWT/Argon2id auth, ownership isolation, and Redis/Celery background jobs.',
      'Benchmarked local PP-OCRv6/ONNX Runtime at 0.008s, 0.033s, and 0.335s for 1, 10, and 100 pages, with peak RSS of 62.1 MB from a 28.6 MB baseline; latest verification reports 268 passing tests.',
    ],
  },
  {
    name: 'Clearance - ATS Resume Intelligence',
    tech: ['TypeScript', 'React', 'Express', 'PostgreSQL', 'Stripe'],
    bullets: [
      'Engineered a deterministic resume analysis engine across 4 evaluation dimensions - formatting, keyword coverage, section completeness, and role fit - returning structured section-level feedback instead of a single opaque score.',
      'Built job-description matching and keyword-gap analysis that surfaced an average of 12 missing keywords per resume and ranked them by impact for targeted editing.',
      'Integrated PDF/DOCX parsing, AI-assisted bullet refinement, Stripe subscriptions, and webhook-enforced usage quotas, supporting 120+ signups across free and paid tiers.',
    ],
  },
  {
    name: 'ToRIS - Token-level Runtime Intelligence System',
    tech: ['Rust', 'Python', 'llama.cpp', 'PyO3', 'axum'],
    bullets: [
      'Designed an inference-time LLM runtime that monitors per-token confidence, Shannon entropy, and varentropy, with evaluation across 5 benchmark datasets to identify unstable decoding states during autoregressive generation.',
      'Implemented adaptive sampling, 1-token KV-cache precision rollback, token banishment, targeted regeneration, and sentence-boundary self-correction, with Python bindings and an OpenAI-compatible axum/SSE inference API.',
      'On 30 Phi-4-mini samples, improved GSM8K from 50.0% to 56.7% (+6.67 pp); a 20-sample x 3-run Qwen3.5-4B sweep measured +5.0% mean MMLU-Pro gain with 0% harm rate.',
    ],
  },
  {
    name: 'Gideon - Offline Local AI Assistant',
    tech: ['Rust', 'Slint', 'llama.cpp', 'LFM2.5-230M', 'fastembed'],
    bullets: [
      'Built a Windows-first, voice-first local AI layer around a system-level Gideon Pill, using Rust/Slint and local 230M-parameter LFM2.5 inference via llama-server with hardware-aware FAST/SMART/AGENT routing and offline-first execution.',
      'Implemented 4 user-facing surfaces - Pill, Memory, Settings, and Chat - with semantic memory search, file/PDF/URL capture, OCR, local speech, clipboard context, desktop automation, web research, tasks, and agent/tool execution with approval gates.',
      'Added keyring-backed secrets, filesystem sandboxing, SSRF protection, secret scanning, event logging, and local OCR/voice pipelines; the latest verification pass reports 802/802 tests passing and zero compiler/Clippy warnings.',
    ],
  },
  {
    name: 'Vault - Personal Command Center',
    tech: ['Next.js', 'TypeScript', 'React Native', 'PostgreSQL', 'Prisma'],
    bullets: [
      'Built a self-hosted full-stack platform spanning 4 modules - notes, projects, calendar, and job tracking - across web and mobile clients with local data ownership.',
      'Implemented offline-first synchronisation and background sync, keeping all 4 modules functional without a connection and syncing changes within 3 seconds of reconnection.',
      'Added JWT authentication and role-based access control supporting up to 10 concurrent users on a single self-hosted instance without cross-account data leakage.',
    ],
  },
];

const EXPERIENCE_BULLETS = [
  'Shipped 8 production enterprise products in 6 months across ERP, dealer management, courier logistics, crypto payments, and inventory, deployed for business clients averaging 15+ daily users.',
  'Built multi-tenant access control, logistics tracking, marketplace, and API-integrated workflows across 5+ client platforms, standardising role and permission systems and reducing new-tenant onboarding time by roughly 40%.',
];

const EDUCATION = [
  {
    degree: 'B.Tech. in Computer Science and Engineering',
    field: 'CGPA 7.4/10',
    institution: 'N.K Orchid College of Engineering and Technology, Solapur',
    graduationYear: '2022 - 2026',
    sortOrder: 0,
    claim:
      'B.Tech. in Computer Science and Engineering at N.K Orchid College of Engineering and Technology, Solapur (2022 to 2026), CGPA 7.4/10.',
    extraClaims: [
      'Coursework: Data Structures and Algorithms, Databases, Operating Systems, Computer Networks, Machine Learning, Compiler Design, Information Retrieval, Image Processing',
    ],
  },
  {
    degree: 'HSC',
    field: 'Science (82.88%)',
    institution: 'M.A. Pangal Junior College of Science, Solapur',
    graduationYear: '2022',
    sortOrder: 1,
    claim: 'HSC at M.A. Pangal Junior College of Science, Solapur (2022), 82.88%.',
    extraClaims: [] as string[],
  },
  {
    degree: 'SSC',
    field: '89.60%',
    institution: 'SSA High School, Solapur',
    graduationYear: '2020',
    sortOrder: 2,
    claim: 'SSC at SSA High School, Solapur (2020), 89.60%.',
    extraClaims: [] as string[],
  },
];

const PATENT = {
  name: 'System and Method for Multimodal Learning-Based Decoding of Dream Narratives Through Correlation with Sleep-State Internal Neural and Neuromuscular Activity',
  issuer: 'Published Patent Application - Application No. 202521099626',
  issuedOn: '2025-11-14',
  statement:
    'Published Patent Application (Published 14/11/2025) - Application No. 202521099626 - System and Method for Multimodal Learning-Based Decoding of Dream Narratives Through Correlation with Sleep-State Internal Neural and Neuromuscular Activity',
};

const LEADERSHIP = [
  {
    name: 'Founder & President - Genesis Open Source Student Club',
    issuer: 'Genesis Open Source Student Club',
    statement: 'Founder & President - Genesis Open Source Student Club',
  },
  {
    name: 'Open Source Lead - Google Developer Groups On Campus, NKOCET',
    issuer: 'Google Developer Groups On Campus, NKOCET',
    statement: 'Open Source Lead - Google Developer Groups On Campus, NKOCET',
  },
  {
    name: 'Google Cloud Arcade Facilitator 2025',
    issuer: 'Google Cloud',
    statement: 'Google Cloud Arcade Facilitator 2025',
  },
  {
    name: 'Team Leader - Smart India Hackathon 2023, 2024 and 2025',
    issuer: 'Smart India Hackathon',
    statement: 'Team Leader - Smart India Hackathon 2023, 2024 and 2025',
  },
];

// The sample fixtures that must not appear in the owner's record. The two experience
// companies are the ones the contract names; the rest are the same fixture set's
// education/project/certification/skill rows.
const FIXTURE_EXPERIENCE_COMPANIES = ['Acme', 'Naval Ordnance Laboratory'];
const FIXTURE_EDUCATION_INSTITUTIONS = ['University of London'];
const FIXTURE_PROJECT_PREFIXES = ['LedgerKit'];
const FIXTURE_CERTIFICATION_PREFIXES = ['Analytical Engine Notes'];
const FIXTURE_SKILLS = ['Postgres', 'Postgres r127', 'kubernetes'];

function rowId(row: Record<string, unknown>, label: string): string {
  const id = row.id;
  if (typeof id !== 'string') throw new Error(`${label} did not return an id`);
  return id;
}

async function ensureUserAndProfile(): Promise<{ userId: string; profileId: string }> {
  const existing = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { name: OWNER.name, email: OWNER.email },
      })
    : await prisma.user.create({ data: { name: OWNER.name, email: OWNER.email } });

  const profile = await prisma.careerProfile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      headline: OWNER.headline,
      summary: OWNER.summary,
      seniority: 'Entry level',
      locationPref: OWNER.location,
      country: 'IN',
      links: {
        email: OWNER.email,
        phone: OWNER.phone,
        website: OWNER.website,
        github: OWNER.github,
        linkedin: OWNER.linkedin,
      },
      targetRoles: ['Software Engineer'],
      topSkills: ['Python', 'TypeScript', 'FastAPI', 'React', 'PostgreSQL', 'RAG'],
      industries: ['ERP', 'Logistics', 'Fintech', 'Mobile'],
      proofPoints: [
        '8 production enterprise products shipped in 6 months',
        '802/802 tests passing on Gideon',
        '268 passing tests on TrashTheTest',
      ],
    },
    update: {
      headline: OWNER.headline,
      summary: OWNER.summary,
      seniority: 'Entry level',
      locationPref: OWNER.location,
      country: 'IN',
      links: {
        email: OWNER.email,
        phone: OWNER.phone,
        website: OWNER.website,
        github: OWNER.github,
        linkedin: OWNER.linkedin,
      },
      targetRoles: ['Software Engineer'],
      topSkills: ['Python', 'TypeScript', 'FastAPI', 'React', 'PostgreSQL', 'RAG'],
      industries: ['ERP', 'Logistics', 'Fintech', 'Mobile'],
    },
  });

  return { userId: user.id, profileId: profile.id };
}

async function removeSampleFixtures(profileId: string): Promise<void> {
  const experiences = await prisma.experience.findMany({
    where: { profileId, company: { in: FIXTURE_EXPERIENCE_COMPANIES } },
    select: { id: true },
  });
  const educations = await prisma.education.findMany({
    where: { profileId, institution: { in: FIXTURE_EDUCATION_INSTITUTIONS } },
    select: { id: true },
  });
  const projects = await prisma.project.findMany({
    where: {
      profileId,
      OR: FIXTURE_PROJECT_PREFIXES.map((prefix) => ({ name: { startsWith: prefix } })),
    },
    select: { id: true },
  });
  const certifications = await prisma.certification.findMany({
    where: {
      profileId,
      OR: FIXTURE_CERTIFICATION_PREFIXES.map((prefix) => ({ name: { startsWith: prefix } })),
    },
    select: { id: true },
  });
  const skills = await prisma.skill.findMany({
    where: {
      profileId,
      OR: [
        { normalized: { in: FIXTURE_SKILLS.map((name) => normalizeSkillName(name)) } },
        // Skill rows are fully seed-managed: the five labelled lines are group entities,
        // and any older per-skill rows are replaced by them. Their claims survive (the FK
        // is SetNull) and are re-attached to the group below.
        { normalized: { notIn: GROUP_SKILL_NORMALS } },
      ],
    },
    select: { id: true },
  });
  // The sample fixture set also left Achievement rows behind. The owner's leadership is
  // stored in the renderable certification section, so no Achievement row is owner data.
  const achievements = await prisma.achievement.findMany({
    where: { profileId },
    select: { id: true },
  });

  const experienceIds = experiences.map((row) => row.id);
  const educationIds = educations.map((row) => row.id);
  const projectIds = projects.map((row) => row.id);
  const certificationIds = certifications.map((row) => row.id);
  const skillIds = skills.map((row) => row.id);
  const achievementIds = achievements.map((row) => row.id);

  await prisma.careerClaim.deleteMany({
    where: {
      profileId,
      OR: [
        { experienceId: { in: experienceIds } },
        { educationId: { in: educationIds } },
        { projectId: { in: projectIds } },
        { certificationId: { in: certificationIds } },
        { skillId: { in: skillIds } },
        { achievementId: { in: achievementIds } },
        { statement: { contains: 'Acme', mode: 'insensitive' } },
        { statement: { contains: 'Naval Ordnance', mode: 'insensitive' } },
      ],
    },
  });

  const removals: Array<[CareerEntityKind, string[]]> = [
    ['experience', experienceIds],
    ['education', educationIds],
    ['project', projectIds],
    ['certification', certificationIds],
    ['skill', skillIds],
    ['achievement', achievementIds],
  ];
  for (const [kind, ids] of removals) {
    for (const id of ids) {
      await deleteCareerEntity(kind, id, profileId, prisma);
    }
  }

  // Every remaining sample claim (including the old "Compilers engineer and rear admiral..."
  // summary and the loose project/achievement statements) is removed. Owner claims carry
  // the marker and are never removed here. `inferenceMethod` is nullable, and SQL's
  // `NOT =` does not match NULL, so the null branch is explicit.
  await prisma.careerClaim.deleteMany({
    where: {
      profileId,
      OR: [{ inferenceMethod: null }, { inferenceMethod: { not: CLAIM_MARKER } }],
    },
  });
}

interface ClaimSpec {
  kind: ClaimKind;
  statement: string;
  attach?: { kind: CareerEntityKind; entityId: string };
  /**
   * The entity kind this statement must NOT be filed under.
   *
   * The role line and a project's name are already the entity's own title/name, so the page
   * must count only the statements under them (the bullets) and the projector must not print
   * the title twice. Re-seeding an older record that did attach them clears the FK here.
   */
  detachFrom?: CareerEntityKind;
}

async function ensureClaim(
  profileId: string,
  actorUserId: string,
  evidenceSourceId: string,
  spec: ClaimSpec,
): Promise<CareerClaimRow> {
  const result = await createClaim(
    {
      profileId,
      kind: spec.kind,
      statement: spec.statement,
      provenance: ClaimProvenance.user_entered,
      confidence: 1,
      inferenceMethod: CLAIM_MARKER,
      evidenceSourceId,
    },
    prisma,
  );

  let claim = result.claim;
  if (claim.status === ClaimStatus.rejected) {
    claim = (await reopenClaim({ claimId: claim.id, actorUserId, note: 'owner CV seed' }, prisma)).claim;
  }
  if (spec.attach !== undefined) {
    claim = (
      await attachClaimToEntity(claim.id, spec.attach.kind, spec.attach.entityId, prisma)
    ).claim;
  } else if (spec.detachFrom !== undefined) {
    claim = (await detachClaimFromEntity(claim.id, { kind: spec.detachFrom }, prisma)).claim;
  }
  claim = (
    await confirmClaim(
      {
        claimId: claim.id,
        actorUserId,
        note: 'Confirmed by the owner as their own CV data',
      },
      prisma,
    )
  ).claim;
  return claim;
}

async function upsertExperience(profileId: string) {
  const data = {
    title: 'Full-Stack Development Intern',
    company: 'JazarTech',
    location: 'Remote',
    employmentType: 'Internship',
    startDate: 'Aug 2025',
    endDate: 'Jan 2026',
    current: false,
    sortOrder: 0,
  };
  const existing = await prisma.experience.findFirst({
    where: { profileId, company: data.company, title: data.title },
    orderBy: { createdAt: 'asc' },
  });
  return existing
    ? updateCareerEntity('experience', existing.id, profileId, data, prisma)
    : createCareerEntity('experience', profileId, data, prisma);
}

async function upsertEducation(profileId: string, seed: (typeof EDUCATION)[number]) {
  const data = {
    degree: seed.degree,
    field: seed.field,
    institution: seed.institution,
    graduationYear: seed.graduationYear,
    sortOrder: seed.sortOrder,
  };
  const existing = await prisma.education.findFirst({
    where: { profileId, institution: seed.institution, degree: seed.degree },
    orderBy: { createdAt: 'asc' },
  });
  return existing
    ? updateCareerEntity('education', existing.id, profileId, data, prisma)
    : createCareerEntity('education', profileId, data, prisma);
}

async function upsertProject(profileId: string, seed: ProjectSeed, sortOrder: number) {
  const data = {
    name: seed.name,
    tech: seed.tech,
    sortOrder,
  };
  const existing = await prisma.project.findFirst({
    where: { profileId, name: seed.name },
    orderBy: { createdAt: 'asc' },
  });
  return existing
    ? updateCareerEntity('project', existing.id, profileId, data, prisma)
    : createCareerEntity('project', profileId, data, prisma);
}

/**
 * One labelled skill line as a Skill entity (`name` = the label, `level` = the list).
 *
 * The entity service caps `level` at 40 characters because the UI treats it as a
 * proficiency ("Expert", "3/5"). The owner's data is five labelled lines whose lists are
 * considerably longer, so these six rows are written directly. This is the one place the
 * seed bypasses the entity validation, and it is deliberate: going through the service
 * would silently truncate the CV. Individual skill names are still CareerClaim rows
 * attached to their group.
 */
async function upsertSkillGroup(
  profileId: string,
  name: string,
  level: string,
  sortOrder: number,
) {
  const normalized = normalizeSkillName(name);
  const existing = await prisma.skill.findFirst({ where: { profileId, normalized } });
  const data = { name, normalized, category: name, level, sortOrder };
  return existing
    ? prisma.skill.update({ where: { id: existing.id }, data })
    : prisma.skill.create({ data: { ...data, profileId } });
}

async function upsertCertification(
  profileId: string,
  data: { name: string; issuer: string; issuedOn?: string },
) {
  const existing = await prisma.certification.findFirst({
    where: { profileId, name: data.name },
    orderBy: { createdAt: 'asc' },
  });
  return existing
    ? updateCareerEntity('certification', existing.id, profileId, data, prisma)
    : createCareerEntity('certification', profileId, data, prisma);
}

function basicsFor(): ProjectionBasics {
  return {
    name: OWNER.name,
    label: OWNER.headline,
    email: OWNER.email,
    phone: OWNER.phone,
    url: OWNER.website,
    summary: OWNER.summary,
    location: {
      city: 'Solapur',
      region: 'Maharashtra',
      country: 'India',
      countryCode: 'IN',
    },
    profiles: [
      { network: 'GitHub', username: 'itsaakif', url: `https://${OWNER.github}` },
      { network: 'LinkedIn', username: 'aakifmudel', url: `https://${OWNER.linkedin}` },
    ],
  };
}

async function main() {
  const { userId, profileId } = await ensureUserAndProfile();
  await removeSampleFixtures(profileId);

  const cvText = JSON.stringify({
    basics: basicsFor(),
    experience: {
      company: 'JazarTech',
      title: 'Full-Stack Development Intern',
      startDate: 'Aug 2025',
      endDate: 'Jan 2026',
      bullets: EXPERIENCE_BULLETS,
    },
    projects: PROJECTS,
    education: EDUCATION,
    skills: SKILL_GROUPS,
    spokenLanguages: SPOKEN_LANGUAGES,
    patent: PATENT,
    leadership: LEADERSHIP,
  });
  const evidence = await createEvidenceSource(
    {
      profileId,
      kind: EvidenceKind.manual,
      title: 'Aakif Mudel - owner-supplied CV',
      text: cvText,
      mimeType: 'application/json',
      trustLevel: 3,
    },
    prisma,
  );

  const summaryClaim = await ensureClaim(profileId, userId, evidence.source.id, {
    kind: ClaimKind.soft_skill,
    statement: OWNER.summary,
  });

  const experience = await upsertExperience(profileId);
  const experienceId = rowId(experience, 'experience');
  await ensureClaim(profileId, userId, evidence.source.id, {
    kind: ClaimKind.role,
    statement: 'Full-Stack Development Intern at JazarTech',
    detachFrom: 'experience',
  });
  for (const bullet of EXPERIENCE_BULLETS) {
    await ensureClaim(profileId, userId, evidence.source.id, {
      kind: ClaimKind.achievement,
      statement: bullet,
      attach: { kind: 'experience', entityId: experienceId },
    });
  }

  for (const [index, project] of PROJECTS.entries()) {
    const row = await upsertProject(profileId, project, index);
    const projectId = rowId(row, `project ${project.name}`);
    await ensureClaim(profileId, userId, evidence.source.id, {
      kind: ClaimKind.project,
      statement: project.name,
      detachFrom: 'project',
    });
    for (const bullet of project.bullets) {
      await ensureClaim(profileId, userId, evidence.source.id, {
        kind: ClaimKind.achievement,
        statement: bullet,
        attach: { kind: 'project', entityId: projectId },
      });
    }
  }

  for (const seed of EDUCATION) {
    const row = await upsertEducation(profileId, seed);
    const educationId = rowId(row, `education ${seed.institution}`);
    await ensureClaim(profileId, userId, evidence.source.id, {
      kind: ClaimKind.education,
      statement: seed.claim,
      attach: { kind: 'education', entityId: educationId },
    });
    for (const extra of seed.extraClaims) {
      await ensureClaim(profileId, userId, evidence.source.id, {
        kind: ClaimKind.domain,
        statement: extra,
        attach: { kind: 'education', entityId: educationId },
      });
    }
  }

  let skillOrder = 0;
  for (const group of SKILL_GROUPS) {
    const row = await upsertSkillGroup(
      profileId,
      group.category,
      group.skills.join(', '),
      skillOrder,
    );
    skillOrder += 1;
    const skillId = rowId(row, `skill group ${group.category}`);
    for (const name of group.skills) {
      await ensureClaim(profileId, userId, evidence.source.id, {
        kind: ClaimKind.skill,
        statement: name,
        attach: { kind: 'skill', entityId: skillId },
      });
    }
  }
  const spoken = await upsertSkillGroup(
    profileId,
    SPOKEN_GROUP,
    SPOKEN_LANGUAGES.join(', '),
    skillOrder,
  );
  const spokenId = rowId(spoken, 'spoken languages group');
  for (const name of SPOKEN_LANGUAGES) {
    await ensureClaim(profileId, userId, evidence.source.id, {
      kind: ClaimKind.language,
      statement: name,
      attach: { kind: 'skill', entityId: spokenId },
    });
  }

  const patent = await upsertCertification(profileId, {
    name: PATENT.name,
    issuer: PATENT.issuer,
    issuedOn: PATENT.issuedOn,
  });
  await ensureClaim(profileId, userId, evidence.source.id, {
    kind: ClaimKind.certification,
    statement: PATENT.statement,
    attach: { kind: 'certification', entityId: rowId(patent, 'patent certification') },
  });

  for (const item of LEADERSHIP) {
    const row = await upsertCertification(profileId, {
      name: item.name,
      issuer: item.issuer,
    });
    await ensureClaim(profileId, userId, evidence.source.id, {
      kind: ClaimKind.certification,
      statement: item.statement,
      attach: { kind: 'certification', entityId: rowId(row, item.name) },
    });
  }

  const basics = basicsFor();
  const input = await loadProjectionInput(profileId, prisma, {
    sourceModelVersion: 2,
    basics,
  });
  const projection = projectResumeJson(input);
  // Every claim is created above, BEFORE this projection, so the projector can name
  // `basics.summary` (T1080) and every highlight. Fail loudly if that ever stops being true:
  // a seeded resume whose summary text is not accounted for in `x-clearance` cannot be saved
  // or rendered, and it would be the only resume in a fresh environment.
  const summaryPlacement = projection.clearance.claims.find(
    (entry) => entry.jsonPath === 'basics.summary',
  );
  if (!summaryPlacement) {
    throw new Error(
      'projected resume does not place the professional summary claim at basics.summary',
    );
  }
  const validation = validateResumeJson(projection.document);
  if (!validation.valid) {
    throw new Error(
      `projected resume is invalid: ${JSON.stringify(validation.errors.slice(0, 5))}`,
    );
  }

  const existingResume = await prisma.resume.findFirst({
    where: { userId, name: RESUME_NAME },
    orderBy: { createdAt: 'asc' },
  });
  const currentRevision = existingResume
    ? await getCurrentRevision(existingResume.id, prisma)
    : null;
  const projectedHash = canonicalJsonHash(projection.document);
  const needsRevision =
    currentRevision === null ||
    currentRevision.jsonHash !== projectedHash;

  const { resume, revision } = await prisma.$transaction(async (tx) => {
    const personalInfo = {
      fullName: OWNER.name,
      headline: OWNER.headline,
      email: OWNER.email,
      phone: OWNER.phone,
      website: OWNER.website,
      github: OWNER.github,
      linkedin: OWNER.linkedin,
      location: OWNER.location,
    };
    const row = existingResume
      ? await tx.resume.update({
          where: { id: existingResume.id },
          data: {
            name: RESUME_NAME,
            templateId: TEMPLATE_ID,
            modelVersion: 2,
            kind: 'master',
            profileId,
            personalInfo,
            summary: OWNER.summary,
          },
        })
      : await tx.resume.create({
          data: {
            userId,
            name: RESUME_NAME,
            templateId: TEMPLATE_ID,
            modelVersion: 2,
            kind: 'master',
            profileId,
            personalInfo,
            summary: OWNER.summary,
          },
        });

    const written = needsRevision
      ? await createRevision(
          {
            resumeId: row.id,
            document: projection.document,
            createdBy: ResumeChangeSource.user,
            createdByUserId: userId,
            reason: 'seeded from the owner-supplied career profile',
          },
          tx as unknown as Parameters<typeof createRevision>[1],
        )
      : currentRevision!;

    return { resume: row, revision: written };
  });

  const [experiences, projects, educations, skills, certifications, achievements, claims] =
    await Promise.all([
      prisma.experience.count({ where: { profileId } }),
      prisma.project.count({ where: { profileId } }),
      prisma.education.count({ where: { profileId } }),
      prisma.skill.count({ where: { profileId } }),
      prisma.certification.count({ where: { profileId } }),
      prisma.achievement.count({ where: { profileId } }),
      prisma.careerClaim.groupBy({
        by: ['status'],
        where: { profileId },
        _count: { _all: true },
      }),
    ]);

  const confirmed =
    claims.find((row) => row.status === ClaimStatus.user_confirmed)?._count._all ?? 0;
  const inferred = claims.find((row) => row.status === ClaimStatus.inferred)?._count._all ?? 0;

  console.log(
    JSON.stringify(
      {
        userId,
        profileId,
        resumeId: resume.id,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        templateId: resume.templateId,
        entityCounts: {
          experience: experiences,
          projects,
          education: educations,
          skills,
          certifications,
          achievements,
        },
        claimCounts: {
          total: claims.reduce((sum, row) => sum + row._count._all, 0),
          confirmed,
          inferred,
          byStatus: Object.fromEntries(claims.map((row) => [row.status, row._count._all])),
        },
        summaryClaimId: summaryClaim.id,
        evidenceSourceId: evidence.source.id,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

