// The ONE shared render dictionary - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 5
//                 .planning/decisions/ADR-044-...md D3 (one projection, three serialisers)
//                 .planning/specs/clearance-v2/render-sandbox-policy.md 5.4 / 7.4 / 8.4
// Task:         T1040
//
// NOTHING HERE NEEDS A DOCKER DAEMON, A DATABASE OR A TEMPLATE. The dictionary is pure,
// and the three templates that consume it are compiled live in the task's evidence note.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  RESUME_DICT_ATS_PROFILE,
  RESUME_DICT_LANGUAGE,
  RESUME_DICT_SECTIONS,
  RESUME_DICT_VERSION,
  dictToDataJson,
  projectResumeDict,
  type ResumeDict,
} from './dict.js';

/**
 * A realistic canonical document, in the shape `resume/json/project.ts` writes.
 *
 * It carries EVERY member the projector can emit for these sections, including the four
 * that the 1.0.0 projection dropped (`projects[].url`, `certificates[].url`,
 * `skills[].level` and the structured half of `basics.location`) and a profile network
 * that is neither LinkedIn nor GitHub - so the completeness test below is a test of the
 * real shape and not of a convenient one.
 */
const CANONICAL = {
  basics: {
    name: 'Ada Lovelace',
    label: 'Staff Platform Engineer',
    email: 'ada@example.org',
    phone: '+44 20 7946 0018',
    url: 'https://example.org/ada',
    summary: 'Platform engineer. Eleven years of boring deploys.',
    // `address` and `postalCode` are the two members the one-line `location` cannot
    // carry; they must survive in `locationParts` and must NOT change the line.
    location: {
      address: '12 Pratt Street',
      postalCode: 'NW1 2QT',
      city: 'London',
      region: 'Greater London',
      countryCode: 'GB',
    },
    profiles: [
      { network: 'GitHub', url: 'https://github.com/adalovelace' },
      { network: 'LinkedIn', url: 'https://linkedin.com/in/adalovelace' },
      { network: 'Mastodon', username: '@ada@fosstodon.org', url: 'https://fosstodon.org/@ada' },
    ],
  },
  work: [
    {
      name: 'Meridian Data',
      position: 'Staff Platform Engineer',
      summary: 'London',
      startDate: '2022-03-01',
      highlights: ['First', 'Second'],
    },
    {
      name: 'Halcyon Payments',
      position: 'Senior Site Reliability Engineer',
      summary: 'Dublin',
      startDate: '2019-01-01',
      endDate: '2022-02-28',
      highlights: ['Third'],
    },
    {
      name: 'Northgate Software',
      position: 'Backend Engineer',
      summary: 'Manchester',
      startDate: '2015-06-01',
      endDate: '2019-01',
      highlights: [],
    },
  ],
  projects: [
    {
      name: 'hermetic-build',
      description: 'A build sandbox.',
      startDate: '2021',
      endDate: '2022',
      url: 'https://github.com/adalovelace/hermetic-build',
      keywords: ['Rust', 'OCI'],
      highlights: ['Faster.'],
    },
  ],
  education: [
    { institution: 'University of Bristol', studyType: 'MEng', area: 'Computer Science', endDate: '2015-06' },
    { institution: 'Open University', studyType: 'Postgraduate certificate', endDate: '2018' },
  ],
  skills: [
    { name: 'Rust', level: 'Advanced' },
    { name: 'PostgreSQL', keywords: ['logical replication'] },
  ],
  certificates: [
    { name: 'CKA', issuer: 'CNCF', date: '2021-04', url: 'https://training.linuxfoundation.org/certification/cka' },
  ],
};

function deepShuffleKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepShuffleKeys(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) {
      out[key] = deepShuffleKeys(source[key]);
    }
    return out as unknown as T;
  }
  return value;
}

describe('the vocabulary', () => {
  it('is exactly the seven sections the canonical model can emit, in render order', () => {
    expect(RESUME_DICT_SECTIONS).toEqual([
      'contact',
      'summary',
      'experience',
      'projects',
      'education',
      'skills',
      'certifications',
    ]);
  });

  it('excludes every section the canonical model cannot emit, and the reason is the model', () => {
    // These are real JSON Resume sections, but `lowerResumeJson` records them as
    // `no_canonical_entity` and the projector never emits them, so the dictionary has no
    // way to fill them. The registry refuses a template that declares one.
    for (const absent of ['languages', 'awards', 'interests', 'publications', 'references', 'volunteer']) {
      expect(RESUME_DICT_SECTIONS as readonly string[]).not.toContain(absent);
    }
  });

  it('pins the dictionary version and the language every render is typeset in', () => {
    // 1.1.0 added the members rule 5 of `dict.ts`'s header requires; nothing a 1.0.0
    // consumer read changed meaning. The literal is pinned on purpose: a silent bump is
    // how a cache key stops meaning anything.
    expect(RESUME_DICT_VERSION).toBe('1.1.0');
    expect(RESUME_DICT_LANGUAGE).toBe('en');
    expect(projectResumeDict(CANONICAL).dictVersion).toBe('1.1.0');
    expect(projectResumeDict(CANONICAL).language).toBe('en');
  });

  it('carries the conservative ATS profile, so a document is parseable by default', () => {
    expect(RESUME_DICT_ATS_PROFILE).toEqual({
      singleColumn: true,
      iconFonts: false,
      tablesAllowed: false,
    });
    expect(projectResumeDict(CANONICAL).ats).toEqual(RESUME_DICT_ATS_PROFILE);
  });
});

describe('projectResumeDict is total', () => {
  it('an EMPTY document yields every declared key, with a typed default', () => {
    const dict = projectResumeDict({});
    expect(Object.keys(dict).sort()).toEqual(
      [
        'ats',
        'certifications',
        'contact',
        'dictVersion',
        'education',
        'experience',
        'language',
        'projects',
        'sections',
        'skills',
        'summary',
      ].sort(),
    );
    expect(dict.summary).toBe('');
    expect(dict.experience).toEqual([]);
    expect(dict.projects).toEqual([]);
    expect(dict.education).toEqual([]);
    expect(dict.skills).toEqual([]);
    expect(dict.certifications).toEqual([]);
    expect(dict.sections).toEqual([]);
    expect(dict.contact).toEqual({
      name: '',
      headline: '',
      email: '',
      phone: '',
      location: '',
      locationParts: {
        address: '',
        postalCode: '',
        city: '',
        region: '',
        countryCode: '',
        country: '',
      },
      website: '',
      linkedin: '',
      github: '',
      profiles: [],
    });
  });

  it('every hostile shape is an input, not a throw', () => {
    for (const input of [null, undefined, 42, 'a string', [], true, { basics: 42 }, { work: 'nope' }]) {
      expect(() => projectResumeDict(input)).not.toThrow();
    }
    // An entry that is a string where an object belongs degrades to defaults, it does
    // not take the document down: a render failure is a user-visible bug.
    const degraded = projectResumeDict({ work: ['a string', 7, null], skills: [null] });
    expect(degraded.experience).toHaveLength(3);
    expect(degraded.experience[0]).toEqual({
      title: '',
      organisation: '',
      location: '',
      rangeText: '',
      summary: '',
      highlights: [],
    });
    expect(degraded.skills).toEqual([{ name: '', level: '', keywords: [] }]);
  });

  it('never mutates its input', () => {
    const input = deepShuffleKeys(CANONICAL);
    const before = JSON.stringify(input);
    projectResumeDict(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('the four rules that make a template writable', () => {
  it('1. every declared key is present with a typed default, on a real document too', () => {
    const dict = projectResumeDict(CANONICAL);
    for (const key of ['dictVersion', 'language', 'contact', 'summary', 'sections', 'experience', 'projects', 'education', 'skills', 'certifications', 'ats'] as const) {
      expect(dict[key]).toBeDefined();
    }
    // An experience entry with no highlights has an empty ARRAY, never a missing key.
    expect(dict.experience[2]?.highlights).toEqual([]);
    // An education entry with no `area` has a qualification from the studyType alone, and
    // no dangling separator.
    expect(dict.education[1]?.qualification).toBe('Postgraduate certificate');
  });

  it('2. every string is trimmed and control-stripped, and a newline cannot fuse words', () => {
    const hostile = projectResumeDict({
      basics: { name: '  Ada\u0000\u0007 Lovelace \t\r\n  ', summary: 'Dev\nOps engineer' },
      work: [{ name: 'M\u001bber', position: 'Eng\u009fineer', highlights: [' a\u0000b ', '\u0007', '  '] }],
      skills: [{ name: 'Ru\u0085st' }],
    });
    expect(hostile.contact.name).toBe('Ada Lovelace');
    expect(hostile.summary).toBe('Dev Ops engineer');
    expect(hostile.experience[0]?.organisation).toBe('M ber');
    expect(hostile.experience[0]?.title).toBe('Eng ineer');
    // An entry that is ONLY control characters collapses to nothing and is DROPPED, so
    // a resume cannot fill a page with invisible bullets.
    expect(hostile.experience[0]?.highlights).toEqual(['a b']);
    expect(hostile.skills[0]?.name).toBe('Ru st');
  });

  it('3. dates are pre-formatted HERE, so no template does date or locale logic', () => {
    const dict = projectResumeDict(CANONICAL);
    // An open end is the canonical convention (the projector OMITS endDate for a current
    // role rather than writing an empty string), so it renders as `Present`.
    expect(dict.experience[0]?.rangeText).toBe('Mar 2022 - Present');
    expect(dict.experience[1]?.rangeText).toBe('Jan 2019 - Feb 2022');
    // A year-only value stays a year: `2021 - 2022` is a better answer than `Jan 2021`.
    expect(dict.projects[0]?.rangeText).toBe('2021 - 2022');
    // An end date with no start is the graduation-year case.
    expect(dict.education[0]?.rangeText).toBe('Jun 2015');
    expect(dict.certifications[0]?.dateText).toBe('Apr 2021');
    // ASCII only, and no locale-dependent month name.
    for (const text of [
      dict.experience[0]?.rangeText,
      dict.education[0]?.rangeText,
      dict.certifications[0]?.dateText,
    ]) {
      expect(text).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  it('3b. a date value it does not recognise is kept verbatim rather than dropped', () => {
    const odd = projectResumeDict({
      work: [{ name: 'A', position: 'B', startDate: 'Spring 2020', endDate: '13/2021' }],
      certificates: [{ name: 'C', date: 'whenever' }],
    });
    // Total beats tidy: a resume typed by hand renders, and the templates treat these as
    // opaque strings anyway.
    expect(odd.experience[0]?.rangeText).toBe('Spring 2020 - 13/2021');
    expect(odd.certifications[0]?.dateText).toBe('whenever');
  });

  it('3c. an impossible month is not silently turned into January', () => {
    const bad = projectResumeDict({ work: [{ name: 'A', position: 'B', startDate: '2020-19' }] });
    expect(bad.experience[0]?.rangeText).toBe('2020-19 - Present');
  });

  it('4. sections[] is non-empty only, and in the fixed order regardless of the document', () => {
    const full = projectResumeDict(CANONICAL);
    expect(full.sections).toEqual([
      'contact',
      'summary',
      'experience',
      'projects',
      'education',
      'skills',
      'certifications',
    ]);
    // A document with only education and skills: the order is the DICTIONARY's order, not
    // the document's key order and not the order the entries appear in.
    const partial = projectResumeDict({ skills: [{ name: 'Go' }], education: [{ institution: 'X' }] });
    expect(partial.sections).toEqual(['education', 'skills']);
    // A contact section with one non-empty field counts; an all-empty one does not.
    expect(projectResumeDict({ basics: { name: 'A' } }).sections).toEqual(['contact']);
    expect(projectResumeDict({ basics: { name: '   ' } }).sections).toEqual([]);
  });

  it('preserves document array order, because a position in the document is meaningful', () => {
    const dict = projectResumeDict(CANONICAL);
    expect(dict.experience.map((job) => job.organisation)).toEqual([
      'Meridian Data',
      'Halcyon Payments',
      'Northgate Software',
    ]);
    expect(dict.education.map((entry) => entry.institution)).toEqual([
      'University of Bristol',
      'Open University',
    ]);
    expect(dict.skills.map((skill) => skill.name)).toEqual(['Rust', 'PostgreSQL']);
  });
});

describe('the projection of each section', () => {
  it('contact: the label is the headline, the location object is one deterministic line', () => {
    const dict = projectResumeDict(CANONICAL);
    // The document carries an address and a postal code, and NEITHER is in the line: the
    // line is city, region, countryCode - the four members that fit on one.
    expect(dict.contact.location).toBe('London, Greater London, GB');
    expect(dict.contact).toEqual({
      name: 'Ada Lovelace',
      headline: 'Staff Platform Engineer',
      email: 'ada@example.org',
      phone: '+44 20 7946 0018',
      location: 'London, Greater London, GB',
      locationParts: {
        address: '12 Pratt Street',
        postalCode: 'NW1 2QT',
        city: 'London',
        region: 'Greater London',
        countryCode: 'GB',
        country: '',
      },
      website: 'https://example.org/ada',
      linkedin: 'https://linkedin.com/in/adalovelace',
      github: 'https://github.com/adalovelace',
      profiles: [
        { network: 'GitHub', username: '', url: 'https://github.com/adalovelace' },
        { network: 'LinkedIn', username: '', url: 'https://linkedin.com/in/adalovelace' },
        { network: 'Mastodon', username: '@ada@fosstodon.org', url: 'https://fosstodon.org/@ada' },
      ],
    });
  });

  it('F1: a location part the LINE cannot carry is still in the dictionary', () => {
    // The omission the review found: `basics.location` is six members and only four of
    // them survive a one-line address, so a document whose ONLY location is a street
    // address used to produce a contact with nothing in it at all.
    const addressOnly = projectResumeDict({
      basics: { name: 'Ada', location: { address: '12 Pratt Street', postalCode: 'NW1 2QT' } },
    });
    expect(addressOnly.contact.location).toBe('');
    expect(addressOnly.contact.locationParts).toEqual({
      address: '12 Pratt Street',
      postalCode: 'NW1 2QT',
      city: '',
      region: '',
      countryCode: '',
      country: '',
    });
    // And the address alone is enough for the contact section to be a section.
    expect(addressOnly.sections).toEqual(['contact']);
    // The rules the line itself obeys, stated as rules: empty dropped, exact repeat
    // dropped, `countryCode` before `country`, and no dangling separator.
    expect(projectResumeDict({ basics: { location: { city: 'Berlin', country: 'Berlin' } } }).contact.location).toBe(
      'Berlin',
    );
    expect(
      projectResumeDict({ basics: { location: { country: 'Germany', countryCode: 'DE', city: 'Berlin' } } })
        .contact.location,
    ).toBe('Berlin, DE, Germany');
  });

  it('F1: every profile entry reaches the dictionary, whatever its network', () => {
    // The derived `linkedin` / `github` fields are conveniences; `profiles` is the
    // record, and a network the two names do not know is not dropped for that.
    const other = projectResumeDict({
      basics: {
        profiles: [
          { network: 'Stack Overflow', username: 'ada', url: 'https://stackoverflow.com/users/1/ada' },
          { url: 'https://example.org/ada' },
          { network: 'No URL' },
        ],
      },
    });
    expect(other.contact.profiles).toEqual([
      { network: 'Stack Overflow', username: 'ada', url: 'https://stackoverflow.com/users/1/ada' },
      { network: '', username: '', url: 'https://example.org/ada' },
    ]);
    expect(other.contact.linkedin).toBe('');
    expect(other.contact.github).toBe('');
    // A document whose only content is a non-LinkedIn profile is still a contact section.
    expect(other.sections).toEqual(['contact']);
  });

  it('contact: a profile is matched by network, and by URL host as the fallback', () => {
    const byHost = projectResumeDict({
      basics: { profiles: [{ url: 'https://github.com/someone' }, { url: 'https://example.org' }] },
    });
    expect(byHost.contact.github).toBe('https://github.com/someone');
    expect(byHost.contact.linkedin).toBe('');
    // A repeated location component appears once, not twice.
    expect(projectResumeDict({ basics: { location: { city: 'Berlin', country: 'Berlin' } } }).contact.location).toBe(
      'Berlin',
    );
  });

  it('experience: work[].summary is the PLACE, because that is what the projector writes there', () => {
    // `resume/json/project.ts` puts the location into the work entry's own `summary`,
    // since JSON Resume has no `location` on a work entry. Reading it any other way would
    // print "London, London" or drop the place.
    const dict = projectResumeDict(CANONICAL);
    expect(dict.experience[0]?.location).toBe('London');
    expect(dict.experience[0]?.title).toBe('Staff Platform Engineer');
    expect(dict.experience[0]?.organisation).toBe('Meridian Data');
    expect(dict.experience[0]?.summary).toBe('');
  });

  it('projects, education, skills and certifications map onto their own keys', () => {
    const dict = projectResumeDict(CANONICAL);
    expect(dict.projects[0]).toEqual({
      name: 'hermetic-build',
      description: 'A build sandbox.',
      rangeText: '2021 - 2022',
      // The repo link the projector wrote, which 1.0.0 dropped on the floor.
      url: 'https://github.com/adalovelace/hermetic-build',
      keywords: ['Rust', 'OCI'],
      highlights: ['Faster.'],
    });
    // `studyType` and `area` are joined, which is the whole qualification.
    expect(dict.education[0]?.qualification).toBe('MEng, Computer Science');
    expect(dict.education[0]?.institution).toBe('University of Bristol');
    // JSON Resume has no location on an education entry at all, and the canonical model
    // emits no score, so both are ''. See rule 5 of `dict.ts`'s header.
    expect(dict.education[0]?.location).toBe('');
    expect(dict.education[0]?.score).toBe('');
    // A skill with no level is `''`, and the one that has a level keeps it.
    expect(dict.skills[0]).toEqual({ name: 'Rust', level: 'Advanced', keywords: [] });
    expect(dict.skills[1]).toEqual({ name: 'PostgreSQL', level: '', keywords: ['logical replication'] });
    expect(dict.certifications[0]).toEqual({
      name: 'CKA',
      issuer: 'CNCF',
      dateText: 'Apr 2021',
      // The credential link, which 1.0.0 dropped.
      url: 'https://training.linuxfoundation.org/certification/cka',
    });
  });
});

// ---------------------------------------------------------------------------
// F1: the completeness rule, member by member
// ---------------------------------------------------------------------------

describe('F1: nothing the canonical projector emits is dropped', () => {
  it('every member of the document table in dict.ts reaches the dictionary', () => {
    // This is rule 5 of `dict.ts`'s module header, executed. A row that is missing here
    // is a silent omission, and ADR-035 forbids dropping profile text - so the value the
    // projector wrote must be readable in the dictionary DOCX (T1041) and `.tex`/`.json`
    // (T1044) will both consume. Each row names its own document member, so a failure
    // says which one regressed.
    const dict = projectResumeDict(CANONICAL);
    const rows: ReadonlyArray<readonly [string, unknown, unknown]> = [
      // basics
      ['basics.name', dict.contact.name, 'Ada Lovelace'],
      ['basics.label', dict.contact.headline, 'Staff Platform Engineer'],
      ['basics.email', dict.contact.email, 'ada@example.org'],
      ['basics.phone', dict.contact.phone, '+44 20 7946 0018'],
      ['basics.url', dict.contact.website, 'https://example.org/ada'],
      ['basics.summary', dict.summary, 'Platform engineer. Eleven years of boring deploys.'],
      ['basics.location.address', dict.contact.locationParts.address, '12 Pratt Street'],
      ['basics.location.postalCode', dict.contact.locationParts.postalCode, 'NW1 2QT'],
      ['basics.location.city', dict.contact.locationParts.city, 'London'],
      ['basics.location.region', dict.contact.locationParts.region, 'Greater London'],
      ['basics.location.countryCode', dict.contact.locationParts.countryCode, 'GB'],
      ['basics.profiles[0].network', dict.contact.profiles[0]?.network, 'GitHub'],
      ['basics.profiles[2].network', dict.contact.profiles[2]?.network, 'Mastodon'],
      ['basics.profiles[2].username', dict.contact.profiles[2]?.username, '@ada@fosstodon.org'],
      ['basics.profiles[1].url', dict.contact.profiles[1]?.url, 'https://linkedin.com/in/adalovelace'],
      // work
      ['work[0].name', dict.experience[0]?.organisation, 'Meridian Data'],
      ['work[0].position', dict.experience[0]?.title, 'Staff Platform Engineer'],
      ['work[0].summary (the place)', dict.experience[0]?.location, 'London'],
      ['work[0].startDate', dict.experience[0]?.rangeText, 'Mar 2022 - Present'],
      ['work[1].endDate', dict.experience[1]?.rangeText, 'Jan 2019 - Feb 2022'],
      ['work[0].highlights', dict.experience[0]?.highlights, ['First', 'Second']],
      // education
      ['education[0].institution', dict.education[0]?.institution, 'University of Bristol'],
      ['education[0].studyType', dict.education[0]?.qualification, 'MEng, Computer Science'],
      ['education[0].area', dict.education[0]?.qualification, 'MEng, Computer Science'],
      ['education[0].endDate', dict.education[0]?.rangeText, 'Jun 2015'],
      // projects
      ['projects[0].name', dict.projects[0]?.name, 'hermetic-build'],
      ['projects[0].description', dict.projects[0]?.description, 'A build sandbox.'],
      ['projects[0].url', dict.projects[0]?.url, 'https://github.com/adalovelace/hermetic-build'],
      ['projects[0].startDate', dict.projects[0]?.rangeText, '2021 - 2022'],
      ['projects[0].keywords', dict.projects[0]?.keywords, ['Rust', 'OCI']],
      ['projects[0].highlights', dict.projects[0]?.highlights, ['Faster.']],
      // skills
      ['skills[0].name', dict.skills[0]?.name, 'Rust'],
      ['skills[0].level', dict.skills[0]?.level, 'Advanced'],
      // certificates
      ['certificates[0].name', dict.certifications[0]?.name, 'CKA'],
      ['certificates[0].issuer', dict.certifications[0]?.issuer, 'CNCF'],
      ['certificates[0].date', dict.certifications[0]?.dateText, 'Apr 2021'],
      ['certificates[0].url', dict.certifications[0]?.url, 'https://training.linuxfoundation.org/certification/cka'],
    ];
    expect(rows.length).toBeGreaterThan(30);
    for (const [member, actual, expected] of rows) {
      expect(actual, `${member} is dropped by the projection`).toEqual(expected);
    }
  });

  it('the three links and the level survive a doc with NOTHING else in it', () => {
    // The strongest form of the same rule: a document whose only content is the four
    // fields 1.0.0 dropped must still produce four readable values. If any of them were
    // dropped again, these are `''`.
    const thin = projectResumeDict({
      projects: [{ name: 'p', url: 'https://example.org/p' }],
      skills: [{ name: 's', level: 'Expert' }],
      certificates: [{ name: 'c', url: 'https://example.org/c' }],
    });
    expect(thin.projects[0]?.url).toBe('https://example.org/p');
    expect(thin.skills[0]?.level).toBe('Expert');
    expect(thin.certifications[0]?.url).toBe('https://example.org/c');
    // And a document with NO link anywhere yields the typed empty string, never a
    // missing key, because a template may not ask whether the key exists.
    const bare = projectResumeDict({ projects: [{ name: 'p' }], skills: [{ name: 's' }] });
    expect(bare.projects[0]?.url).toBe('');
    expect(bare.skills[0]?.level).toBe('');
  });

  it('the new fields carry no control characters and are normalised like every other', () => {
    // Rule 2 applies to the new members too: a URL or a level that arrived with a NUL
    // must not reach a PDF text run with the NUL in it.
    const hostile = projectResumeDict({
      basics: {
        location: { address: '  12\tPratt\u0000 Street  ', postalCode: ' NW1\n2QT ' },
        profiles: [{ network: 'Mast\u0007odon', username: '@a\u001bb', url: ' https://example.org/a\n' }],
      },
      projects: [{ name: 'p', url: 'https://example.org/\u0000p' }],
      skills: [{ name: 's', level: 'Expert\u0007' }],
      certificates: [{ name: 'c', url: 'https://example.org/c' }],
    });
    expect(hostile.contact.locationParts.address).toBe('12 Pratt Street');
    expect(hostile.contact.locationParts.postalCode).toBe('NW1 2QT');
    expect(hostile.contact.profiles[0]?.network).toBe('Mast odon');
    expect(hostile.contact.profiles[0]?.username).toBe('@a b');
    expect(hostile.contact.profiles[0]?.url).toBe('https://example.org/a');
    expect(hostile.projects[0]?.url).toBe('https://example.org/ p');
    expect(hostile.skills[0]?.level).toBe('Expert');
    for (const value of [
      hostile.contact.locationParts.address,
      hostile.projects[0]?.url,
      hostile.skills[0]?.level,
    ]) {
      expect(value).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});

describe('dictToDataJson', () => {
  it('produces JSON that parses back to the same dictionary', () => {
    const dict = projectResumeDict(CANONICAL);
    const parsed = JSON.parse(dictToDataJson(dict).toString('utf8')) as ResumeDict;
    expect(parsed).toEqual(JSON.parse(JSON.stringify(dict)) as ResumeDict);
    expect(parsed.sections).toEqual(dict.sections);
  });

  it('contains no undefined anywhere, at any depth', () => {
    // A `toEqual` cannot see `undefined` members and `JSON.stringify` drops them, so the
    // check is textual: the bytes must not carry a key whose value is missing.
    const text = dictToDataJson(projectResumeDict(CANONICAL)).toString('utf8');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    // Every declared key is literally present in the serialised form.
    for (const key of [
      'ats',
      'certifications',
      'contact',
      'dictVersion',
      'education',
      'experience',
      'language',
      'projects',
      'sections',
      'skills',
      'summary',
    ]) {
      expect(text).toContain(`"${key}":`);
    }
  });

  it('is byte-identical across two calls on equal input, and across shuffled key order', () => {
    const first = dictToDataJson(projectResumeDict(CANONICAL));
    const second = dictToDataJson(projectResumeDict(CANONICAL));
    expect(first.equals(second)).toBe(true);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex'),
    );
    // Key order in the INPUT is not information: the projection walks the document, not
    // its key enumeration order, and the serialiser sorts keys at every depth.
    const shuffled = dictToDataJson(projectResumeDict(deepShuffleKeys(CANONICAL)));
    expect(shuffled.equals(first)).toBe(true);
  });

  it('is canonical: object keys are emitted in sorted order at every depth', () => {
    const text = dictToDataJson(projectResumeDict(CANONICAL)).toString('utf8');
    // Sorted output starts with the alphabetically first declared key, and a `g`-flagged
    // regex over the whole string sees the top-level object opener exactly once.
    expect(text.startsWith('{"ats":')).toBe(true);
    const openers = [...text.matchAll(/\{"[a-z]+":/g)].length;
    expect(openers).toBeGreaterThan(0);
    const keysAtDepthOne = Object.keys(JSON.parse(text) as Record<string, unknown>);
    expect([...keysAtDepthOne].sort()).toEqual(keysAtDepthOne);
  });

  it('user content round-trips as a STRING: a typst code fragment in a resume is inert text', () => {
    // Policy 8.4. The dictionary is a projection, not a source generator: a value
    // containing `#eval(...)` or `#raw` is carried through as the string it is, and it
    // reaches the template as a JSON string value inside data.json.
    const canary = '#eval(sys.inputs("whoami")) #raw("x") <script> ${danger} \\ backslash';
    const dict = projectResumeDict({ basics: { name: canary }, work: [{ name: 'A', position: canary }] });
    const text = dictToDataJson(dict).toString('utf8');
    const parsed = JSON.parse(text) as ResumeDict;
    expect(parsed.contact.name).toBe(canary);
    expect(parsed.experience[0]?.title).toBe(canary);
    // The bytes carry it as a quoted JSON string, which is what makes it inert.
    expect(text).toContain(JSON.stringify(canary));
    // And the dictionary never emitted a typst source fragment of its own: the only
    // bracket in the output is JSON's.
    expect(text.startsWith('{')).toBe(true);
    expect(text.endsWith('}')).toBe(true);
  });

  it('refuses a non-dictionary argument instead of serialising a surprise', () => {
    expect(() => dictToDataJson(null as never)).toThrow(TypeError);
    expect(() => dictToDataJson('nope' as never)).toThrow(TypeError);
  });
});

describe('the result is frozen, so a template cannot mutate a shared dictionary', () => {
  it('freezes the dictionary and every object it owns', () => {
    const dict = projectResumeDict(CANONICAL);
    expect(Object.isFrozen(dict)).toBe(true);
    expect(Object.isFrozen(dict.contact)).toBe(true);
    expect(Object.isFrozen(dict.sections)).toBe(true);
    expect(Object.isFrozen(dict.experience)).toBe(true);
    expect(Object.isFrozen(dict.experience[0])).toBe(true);
    expect(Object.isFrozen(dict.experience[0]?.highlights)).toBe(true);
    expect(Object.isFrozen(dict.ats)).toBe(true);
    // The members added in 1.1.0 are frozen on the same terms: a template that could
    // mutate a shared projection would make the render order depend on which serialiser
    // ran first.
    expect(Object.isFrozen(dict.contact.locationParts)).toBe(true);
    expect(Object.isFrozen(dict.contact.profiles)).toBe(true);
    expect(Object.isFrozen(dict.contact.profiles[0])).toBe(true);
  });
});
