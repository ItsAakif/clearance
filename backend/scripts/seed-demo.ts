// Seed a fictional demo person into the live V2 career model for publication screenshots.
//
// Run: cd backend && npx tsx scripts/seed-demo.ts
//
// This is a DEMO fixture, not owner data. It replaces the career/resume/application data
// for the singleton user (and the interview/Q&A rows that would otherwise show the owner's
// name on the Interview screens), while leaving JobListing completely untouched.
//
// Idempotent by construction: it clears the demo-owned rows first, then recreates them.
// The owner's database is backed up before this runs and restored afterwards, so no owner
// row depends on this script's cleanup being reversible.

import {
  ClaimKind,
  ClaimProvenance,
  ClaimStatus,
  EvidenceKind,
  PrismaClient,
  ResumeChangeSource,
} from '@prisma/client';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  attachClaimToEntity,
  createCareerEntity,
  normalizeSkillName,
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
import { analyzeJob } from '../src/jobs/analyze.js';
import { matchJob } from '../src/match/report.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5543/clearance?schema=public';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const DEMO = {
  name: 'Jane Doe',
  email: 'jane.doe@example.com',
  phone: '+1 415 555 0132',
  website: 'https://janedoe.design',
  github: 'github.com/janedoe',
  linkedin: 'linkedin.com/in/janedoe',
  location: 'San Francisco, CA',
  headline: 'Senior Product Designer',
  summary:
    'Senior product designer with nine years of experience across logistics and fintech. I turn complex operational workflows into clear, accessible products, from early research through shipped design systems. I work closely with engineering and product teams to make evidence-led decisions and keep design quality high as products scale.',
} as const;

const CLAIM_MARKER = 'demo_seed';
const RESUME_NAME = 'Jane Doe - Product Designer';
const TEMPLATE_ID = 'latex-medium-professional';
const WRITTEN_IDS = resolve(process.cwd(), '../.cache/demo-ids.json');

interface SkillGroup {
  category: string;
  skills: string[];
}

const SKILL_GROUPS: SkillGroup[] = [
  {
    category: 'Design',
    skills: [
      'Product design',
      'Interaction design',
      'Visual design',
      'Design systems',
      'Prototyping',
      'Information architecture',
      'Accessibility',
    ],
  },
  {
    category: 'Research',
    skills: [
      'User research',
      'Usability testing',
      'Interviews',
      'Journey mapping',
      'Synthesis',
      'Survey design',
    ],
  },
  {
    category: 'Tools',
    skills: ['Figma', 'FigJam', 'Storybook', 'Maze', 'Notion', 'Jira', 'Linear'],
  },
  {
    category: 'Frontend',
    skills: ['HTML', 'CSS', 'JavaScript', 'React', 'Tailwind CSS', 'TypeScript'],
  },
  {
    category: 'Collaboration',
    skills: [
      'Design critique',
      'Cross-functional leadership',
      'Workshop facilitation',
      'Stakeholder alignment',
      'Mentoring',
      'Roadmap planning',
    ],
  },
];

const EXPERIENCES = [
  {
    company: 'Northwind Logistics',
    title: 'Senior Product Designer',
    location: 'Remote',
    employmentType: 'Full-time',
    startDate: 'Mar 2021',
    endDate: 'Present',
    current: true,
    sortOrder: 0,
    bullets: [
      "Led the redesign of Northwind's shipment tracking workspace, cutting support tickets about delivery status by 38% across 14 enterprise accounts.",
      'Built and maintained a shared design system used by four product squads, reducing new-screen design time from five days to two.',
      'Ran quarterly research with dispatchers and warehouse managers, turning findings into a prioritised roadmap adopted by the operations group.',
    ],
  },
  {
    company: 'Fieldnote',
    title: 'Product Designer',
    location: 'San Francisco, CA',
    employmentType: 'Full-time',
    startDate: 'Jun 2018',
    endDate: 'Feb 2021',
    current: false,
    sortOrder: 1,
    bullets: [
      "Designed the first version of Fieldnote's mobile inspection flow, taking it from concept to launch for 120 field teams.",
      'Partnered with fintech customers to simplify expense capture, raising completed submissions per week by 27%.',
    ],
  },
];

const PROJECTS = [
  {
    name: 'Ledgerly Design System',
    tech: ['Figma', 'Storybook', 'React', 'Tokens Studio'],
    bullets: [
      'Documented 48 components, 120 tokens, and accessibility guidance in a single library adopted across three fintech products.',
      'Cut design-to-development handoff time by 35% by pairing every component with usage rules and a React reference implementation.',
    ],
  },
  {
    name: 'Fleet Tracker',
    tech: ['Figma', 'Maze', 'Design systems', 'Accessibility'],
    bullets: [
      'Redesigned live fleet visibility around three dispatch jobs-to-be-done, validated with 18 dispatcher interviews and two rounds of usability testing.',
      'Introduced map, table, and alert views with WCAG 2.1 AA contrast and keyboard paths, reducing time-to-find a vehicle by 41%.',
    ],
  },
  {
    name: 'Notes by Hand',
    tech: ['Figma', 'User research', 'Prototyping'],
    bullets: [
      'Explored a calmer note-taking experience for field technicians, testing six interaction models with 12 participants.',
      'Shipped the winning prototype as a two-week pilot, with 82% of technicians completing a note without training.',
    ],
  },
];

const EDUCATION = [
  {
    degree: 'MDes',
    field: 'Design',
    institution: 'California College of the Arts',
    graduationYear: '2016 - 2018',
    sortOrder: 0,
    claim: 'MDes in Design at California College of the Arts (2016 to 2018).',
  },
  {
    degree: 'BFA',
    field: 'Design',
    institution: 'University of Michigan',
    graduationYear: '2012 - 2016',
    sortOrder: 1,
    claim: 'BFA in Design at the University of Michigan (2012 to 2016).',
  },
];

const CERTIFICATIONS = [
  { name: 'Accessibility Specialist', issuer: 'International Association of Accessibility Professionals' },
  { name: 'Design Systems Certificate', issuer: 'Design Systems International' },
];

// Four real, active catalogue rows. Resolved by company + title so the fixture does not
// depend on a uuid that a later catalogue sync could change.
const APPLICATION_POSTINGS = [
  { company: 'roblox', title: '[2027] Associate Product Designer, Early Career', status: 'saved' },
  { company: 'reddit', title: 'Group Product Manager, Finance Technology', status: 'applied' },
  { company: 'ridgeline', title: 'Staff Product Designer', status: 'interview' },
  { company: 'reddit', title: 'Senior Product Manager, Go-To-Market Systems', status: 'offer' },
] as const;

const APPLICATION_NOTES: Record<(typeof APPLICATION_POSTINGS)[number]['status'], string> = {
  saved: 'Strong portfolio fit: logistics tracking and design systems both map to the team. Tailor the Fleet Tracker story before applying.',
  applied: 'Applied through the company site. Referral from a former Fieldnote colleague; follow up with the recruiter next week.',
  interview: 'Portfolio review scheduled. Prepare the Ledgerly design-system case study and the accessibility trade-offs behind it.',
  offer: 'Offer received. Negotiating scope for the design-systems charter; compare against the Northwind package before deciding.',
};

function rowId(row: Record<string, unknown>, label: string): string {
  const id = row.id;
  if (typeof id !== 'string') throw new Error(`${label} did not return an id`);
  return id;
}

async function clearDemoOwnedData(userId: string): Promise<void> {
  // Application before the rows it points at; resume before its projection parents.
  await prisma.application.deleteMany({ where: { userId } });
  await prisma.tailoredResume.deleteMany({ where: { userId } });
  await prisma.interviewQuestion.deleteMany({ where: { userId } });
  await prisma.interviewRisk.deleteMany({ where: { userId } });
  await prisma.questionAnswer.deleteMany({ where: { userId } });
  await prisma.job.deleteMany({ where: { userId } });
  await prisma.resume.deleteMany({ where: { userId } });
  const profile = await prisma.careerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (profile) {
    await prisma.careerProfile.delete({ where: { id: profile.id } });
  }
}

async function ensureDemoUser(): Promise<{ userId: string }> {
  const existing = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { name: DEMO.name, email: DEMO.email },
      })
    : await prisma.user.create({ data: { name: DEMO.name, email: DEMO.email } });
  return { userId: user.id };
}

async function createDemoProfile(userId: string): Promise<string> {
  const profile = await prisma.careerProfile.create({
    data: {
      userId,
      headline: DEMO.headline,
      summary: DEMO.summary,
      seniority: 'Senior',
      locationPref: DEMO.location,
      country: 'US',
      currency: 'USD',
      minSalary: 150000,
      maxSalary: 190000,
      links: {
        email: DEMO.email,
        phone: DEMO.phone,
        website: DEMO.website,
        github: DEMO.github,
        linkedin: DEMO.linkedin,
      },
      targetRoles: ['Senior Product Designer', 'Staff Product Designer', 'Design Lead'],
      topSkills: ['Product design', 'Design systems', 'User research', 'Prototyping', 'Figma'],
      industries: ['Logistics', 'Fintech', 'SaaS'],
      proofPoints: [
        'Cut tracking support tickets by 38% across 14 enterprise accounts',
        'Built a design system used by four product squads',
        'Reduced time-to-find a vehicle by 41%',
      ],
    },
  });
  return profile.id;
}

interface ClaimSpec {
  kind: ClaimKind;
  statement: string;
  attach?: { kind: CareerEntityKind; entityId: string };
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
    claim = (await reopenClaim({ claimId: claim.id, actorUserId, note: 'demo seed' }, prisma)).claim;
  }
  if (spec.attach !== undefined) {
    claim = (
      await attachClaimToEntity(claim.id, spec.attach.kind, spec.attach.entityId, prisma)
    ).claim;
  }
  claim = (
    await confirmClaim(
      { claimId: claim.id, actorUserId, note: 'Confirmed as demo profile data' },
      prisma,
    )
  ).claim;
  return claim;
}

function basicsFor(): ProjectionBasics {
  return {
    name: DEMO.name,
    label: DEMO.headline,
    email: DEMO.email,
    phone: DEMO.phone,
    url: DEMO.website,
    summary: DEMO.summary,
    location: {
      city: 'San Francisco',
      region: 'CA',
      country: 'United States',
      countryCode: 'US',
    },
    profiles: [
      { network: 'GitHub', username: 'janedoe', url: `https://${DEMO.github}` },
      { network: 'LinkedIn', username: 'janedoe', url: `https://${DEMO.linkedin}` },
    ],
  };
}

async function pickApplicationListings(): Promise<Array<{ id: string; title: string; company: string; status: string }>> {
  const picked: Array<{ id: string; title: string; company: string; status: string }> = [];
  for (const wanted of APPLICATION_POSTINGS) {
    const listing = await prisma.jobListing.findFirst({
      where: {
        isActive: true,
        company: wanted.company,
        title: { contains: wanted.title, mode: 'insensitive' },
      },
      orderBy: { postedAt: 'desc' },
      select: { id: true, title: true, company: true },
    });
    if (listing && !picked.some((row) => row.id === listing.id)) {
      picked.push({ ...listing, status: wanted.status });
    }
  }
  if (picked.length < 4) {
    const fallback = await prisma.jobListing.findMany({
      where: {
        isActive: true,
        OR: [
          { title: { contains: 'Product Designer', mode: 'insensitive' } },
          { title: { contains: 'Product Manager', mode: 'insensitive' } },
        ],
      },
      orderBy: { postedAt: 'desc' },
      take: 12,
      select: { id: true, title: true, company: true },
    });
    for (const listing of fallback) {
      if (picked.length >= 4) break;
      if (!picked.some((row) => row.id === listing.id)) {
        picked.push({ ...listing, status: 'saved' });
      }
    }
  }
  if (picked.length < 4) {
    throw new Error(`only ${picked.length} active design/PM postings were available`);
  }
  // The four stages are part of the fixture, not a property of which catalogue row was
  // resolvable: keep the saved/applied/interview/offer sequence in APPLICATION_POSTINGS order.
  return picked.slice(0, 4).map((listing, index) => ({
    ...listing,
    status: APPLICATION_POSTINGS[index].status,
  }));
}

function applicationEvents(status: string, index: number) {
  const from = index === 0 ? null : APPLICATION_POSTINGS[index - 1].status;
  const notes = APPLICATION_NOTES[status as keyof typeof APPLICATION_NOTES];
  switch (status) {
    case 'saved':
      return { type: 'note_added', fromStatus: null, toStatus: 'saved', title: 'Saved for review', description: notes };
    case 'applied':
      return { type: 'note_added', fromStatus: from, toStatus: 'applied', title: 'Application sent', description: notes };
    case 'interview':
      return {
        type: 'interview_scheduled',
        fromStatus: from,
        toStatus: 'interview',
        title: 'Portfolio review',
        description: notes,
        scheduledAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      };
    case 'offer':
      return {
        type: 'offer_received',
        fromStatus: from,
        toStatus: 'offer',
        title: 'Offer received',
        description: notes,
        completedAt: new Date(),
      };
    default:
      return { type: 'note_added', fromStatus: from, toStatus: status, title: 'Status update', description: notes };
  }
}

async function main(): Promise<void> {
  const { userId } = await ensureDemoUser();
  await clearDemoOwnedData(userId);
  const profileId = await createDemoProfile(userId);

  const cvText = JSON.stringify({
    basics: basicsFor(),
    experience: EXPERIENCES,
    projects: PROJECTS,
    education: EDUCATION,
    skills: SKILL_GROUPS,
    certifications: CERTIFICATIONS,
  });
  const evidence = await createEvidenceSource(
    {
      profileId,
      kind: EvidenceKind.manual,
      title: 'Jane Doe - demo profile',
      text: cvText,
      mimeType: 'application/json',
      trustLevel: 3,
    },
    prisma,
  );

  let claimCount = 0;
  const claim = async (spec: ClaimSpec) => {
    const row = await ensureClaim(profileId, userId, evidence.source.id, spec);
    claimCount += 1;
    return row;
  };

  await claim({ kind: ClaimKind.soft_skill, statement: DEMO.summary });

  for (const experienceSeed of EXPERIENCES) {
    const experience = await createCareerEntity(
      'experience',
      profileId,
      {
        title: experienceSeed.title,
        company: experienceSeed.company,
        location: experienceSeed.location,
        employmentType: experienceSeed.employmentType,
        startDate: experienceSeed.startDate,
        endDate: experienceSeed.endDate,
        current: experienceSeed.current,
        sortOrder: experienceSeed.sortOrder,
      },
      prisma,
    );
    const experienceId = rowId(experience, `experience ${experienceSeed.company}`);
    await claim({
      kind: ClaimKind.role,
      statement: `${experienceSeed.title} at ${experienceSeed.company}`,
    });
    for (const bullet of experienceSeed.bullets) {
      await claim({
        kind: ClaimKind.achievement,
        statement: bullet,
        attach: { kind: 'experience', entityId: experienceId },
      });
    }
  }

  for (const [index, projectSeed] of PROJECTS.entries()) {
    const project = await createCareerEntity(
      'project',
      profileId,
      { name: projectSeed.name, tech: projectSeed.tech, sortOrder: index },
      prisma,
    );
    const projectId = rowId(project, `project ${projectSeed.name}`);
    await claim({ kind: ClaimKind.project, statement: projectSeed.name });
    for (const bullet of projectSeed.bullets) {
      await claim({
        kind: ClaimKind.achievement,
        statement: bullet,
        attach: { kind: 'project', entityId: projectId },
      });
    }
  }

  for (const educationSeed of EDUCATION) {
    const education = await createCareerEntity(
      'education',
      profileId,
      {
        degree: educationSeed.degree,
        field: educationSeed.field,
        institution: educationSeed.institution,
        graduationYear: educationSeed.graduationYear,
        sortOrder: educationSeed.sortOrder,
      },
      prisma,
    );
    await claim({
      kind: ClaimKind.education,
      statement: educationSeed.claim,
      attach: { kind: 'education', entityId: rowId(education, educationSeed.institution) },
    });
  }

  for (const [index, group] of SKILL_GROUPS.entries()) {
    // The group's `level` column is the rendered skill list; the entity service caps it at
    // 40 characters, so this one fixture writes the row directly (same reason as seed-aakif).
    const skill = await prisma.skill.create({
      data: {
        profileId,
        name: group.category,
        normalized: normalizeSkillName(group.category),
        category: group.category,
        level: group.skills.join(', '),
        sortOrder: index,
      },
    });
    await claim({
      kind: ClaimKind.skill,
      statement: group.skills.join(', '),
      attach: { kind: 'skill', entityId: skill.id },
    });
  }

  for (const certification of CERTIFICATIONS) {
    const row = await createCareerEntity(
      'certification',
      profileId,
      { name: certification.name, issuer: certification.issuer },
      prisma,
    );
    await claim({
      kind: ClaimKind.certification,
      statement: `${certification.name} - ${certification.issuer}`,
      attach: { kind: 'certification', entityId: rowId(row, certification.name) },
    });
  }

  const basics = basicsFor();
  const input = await loadProjectionInput(profileId, prisma, {
    sourceModelVersion: 2,
    basics,
  });
  const projection = projectResumeJson(input);
  const summaryPlacement = projection.clearance.claims.find(
    (entry) => entry.jsonPath === 'basics.summary',
  );
  if (!summaryPlacement) {
    throw new Error('projected demo resume does not place the summary claim');
  }
  const validation = validateResumeJson(projection.document);
  if (!validation.valid) {
    throw new Error(`projected demo resume is invalid: ${JSON.stringify(validation.errors.slice(0, 5))}`);
  }

  const existingResume = await prisma.resume.findFirst({
    where: { userId, name: RESUME_NAME },
    orderBy: { createdAt: 'asc' },
  });
  const currentRevision = existingResume ? await getCurrentRevision(existingResume.id, prisma) : null;
  const projectedHash = canonicalJsonHash(projection.document);
  const needsRevision = currentRevision === null || currentRevision.jsonHash !== projectedHash;

  const { resume, revision } = await prisma.$transaction(async (tx) => {
    const personalInfo = {
      fullName: DEMO.name,
      headline: DEMO.headline,
      email: DEMO.email,
      phone: DEMO.phone,
      website: DEMO.website,
      github: DEMO.github,
      linkedin: DEMO.linkedin,
      location: DEMO.location,
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
            summary: DEMO.summary,
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
            summary: DEMO.summary,
          },
        });

    const written = needsRevision
      ? await createRevision(
          {
            resumeId: row.id,
            document: projection.document,
            createdBy: ResumeChangeSource.user,
            createdByUserId: userId,
            reason: 'seeded from the fictional demo profile',
          },
          tx as unknown as Parameters<typeof createRevision>[1],
        )
      : currentRevision!;

    return { resume: row, revision: written };
  });

  const listings = await pickApplicationListings();
  const applicationIds: Array<{ id: string; status: string; jobListingId: string; title: string; company: string }> = [];
  const now = Date.now();
  for (const [index, listing] of listings.entries()) {
    const tailored = await prisma.tailoredResume.create({
      data: {
        userId,
        sourceResumeId: resume.id,
        templateId: TEMPLATE_ID,
        jobListingId: listing.id,
        title: `${DEMO.name} - ${listing.title}`,
        content: projection.document as object,
      },
    });
    const event = applicationEvents(listing.status, index);
    const application = await prisma.application.create({
      data: {
        userId,
        jobListingId: listing.id,
        tailoredResumeId: tailored.id,
        status: listing.status,
        notes: APPLICATION_NOTES[listing.status as keyof typeof APPLICATION_NOTES],
        appliedAt: listing.status === 'saved' ? null : new Date(now - (10 - index) * 3 * 24 * 60 * 60 * 1000),
        createdAt: new Date(now - (10 - index) * 24 * 60 * 60 * 1000),
        events: {
          create: {
            type: event.type,
            fromStatus: event.fromStatus,
            toStatus: event.toStatus,
            title: event.title,
            description: event.description,
            scheduledAt: 'scheduledAt' in event ? event.scheduledAt : null,
            completedAt: 'completedAt' in event ? event.completedAt : null,
          },
        },
      },
    });
    applicationIds.push({
      id: application.id,
      status: listing.status,
      jobListingId: listing.id,
      title: listing.title,
      company: listing.company,
    });
  }

  // One real match run for the workspace that the screenshot uses. The service is the
  // same one behind POST /jobs/analyze + POST /jobs/:id/match; running it here avoids a
  // second login just to prepare fixture data.
  let matched: { jobId: string; matchReportId: string } | null = null;
  const matchedApplication = applicationIds.find((row) => row.status === 'interview') ?? applicationIds[0];
  try {
    const analysis = await analyzeJob(
      {
        listingId: matchedApplication.jobListingId,
        text: null,
        url: null,
        fileId: null,
        title: matchedApplication.title,
        company: matchedApplication.company,
        location: null,
        employmentType: null,
        userId,
      },
      prisma as unknown as Parameters<typeof analyzeJob>[1],
    );
    const report = await matchJob(
      { userId, jobId: analysis.jobId, resumeId: resume.id },
      prisma as unknown as Parameters<typeof matchJob>[1],
    );
    matched = { jobId: analysis.jobId, matchReportId: report.matchReportId };
  } catch (error) {
    console.warn('[seed-demo] match run failed; the Match tab will be honest-empty:', error);
  }

  // A small, fictional Q&A bank so the Interview > Question bank screenshot is a
  // populated screen rather than an empty state. It contains no owner data.
  await prisma.questionAnswer.createMany({
    data: [
      {
        userId,
        question: 'Tell me about a design system you built and how you drove adoption.',
        answer:
          'At Northwind I built Ledgerly around 48 components and 120 tokens, documented usage rules with each one, and paired every release with a React reference implementation. Adoption came from four squads using it in their roadmaps, which cut new-screen design time from five days to two.',
        category: 'behavioral',
        notes: 'Lead with the adoption mechanism, not the component count.',
        tags: ['design systems', 'leadership'],
      },
      {
        userId,
        question: 'How do you decide which research findings make it into the roadmap?',
        answer:
          'I cluster findings by the job they block, size each cluster by the number of accounts affected, and bring the evidence to the operations group with a recommendation. At Northwind the quarterly dispatcher research produced the tracking redesign that cut status tickets by 38%.',
        category: 'situational',
        notes: 'Use the 38% result as the outcome.',
        tags: ['research', 'prioritisation'],
      },
      {
        userId,
        question: 'How do you make accessibility part of the design process rather than a final audit?',
        answer:
          'Accessibility is a review criterion in the design system: components ship with contrast, focus, and keyboard guidance, and usability tests include assistive-technology users. On Fleet Tracker that practice caught the map and table keyboard paths before engineering started.',
        category: 'technical',
        notes: 'Mention WCAG 2.1 AA and the Fleet Tracker example.',
        tags: ['accessibility', 'process'],
      },
    ],
  });

  const counts = {
    experience: await prisma.experience.count({ where: { profileId } }),
    projects: await prisma.project.count({ where: { profileId } }),
    education: await prisma.education.count({ where: { profileId } }),
    skills: await prisma.skill.count({ where: { profileId } }),
    certifications: await prisma.certification.count({ where: { profileId } }),
    achievements: await prisma.achievement.count({ where: { profileId } }),
    claims: claimCount,
    resumes: await prisma.resume.count({ where: { userId } }),
    applications: await prisma.application.count({ where: { userId } }),
  };

  const ids = {
    userId,
    profileId,
    resumeId: resume.id,
    revisionId: revision.id,
    templateId: TEMPLATE_ID,
    applicationId: matchedApplication.id,
    matchedApplicationId: matchedApplication.id,
    jobId: matched?.jobId ?? null,
    matchReportId: matched?.matchReportId ?? null,
    applications: applicationIds,
    counts,
  };
  mkdirSync(dirname(WRITTEN_IDS), { recursive: true });
  writeFileSync(WRITTEN_IDS, JSON.stringify(ids, null, 2));

  console.log(JSON.stringify(ids, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
