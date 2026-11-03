import { describe, it, expect } from 'vitest';
import {
  expand,
  MAX_DORK_QUERIES_PER_RUN,
  MAX_DORK_RESULTS_PER_QUERY,
  MAX_DORK_QUERY_CHARS,
  SENIORITY_LEVELS,
} from './expand.js';
import type { SearchIntent } from './expand.js';
import { DORK_TEMPLATES } from './templates.js';
import type { DorkTemplate } from './templates.js';

const RICH_INTENT: SearchIntent = {
  roles: ['React Engineer'],
  skills: ['TypeScript'],
  seniority: 'senior',
  exclusions: ['intern'],
  locations: ['Berlin, Germany'],
  companies: ['acme.example'],
};

function templateById(id: string): DorkTemplate {
  const found = DORK_TEMPLATES.filter((t) => t.id === id);
  expect(found.length).toBe(1);
  return found[0];
}

// Every operator marker the builder can emit. A query whose marker is not
// in its template's declared `operators` is a defect (T700 STEP 5).
function markersInQuery(q: string): string[] {
  const markers: string[] = [];
  const maybe = (marker: string, present: boolean): void => {
    if (present) markers.push(marker);
  };
  maybe('site:', q.indexOf('site:') !== -1);
  maybe('inurl:', q.indexOf('inurl:') !== -1);
  maybe('intitle:', q.indexOf('intitle:') !== -1);
  maybe('"', q.indexOf('"') !== -1);
  maybe('OR', /(^|[^A-Za-z])OR([^A-Za-z]|$)/.test(q));
  maybe('(', q.indexOf('(') !== -1);
  maybe(')', q.indexOf(')') !== -1);
  maybe('-', /(^|\s)-/.test(q));
  return markers;
}

describe('dork query expansion', () => {
  it('is deterministic across calls for a fixed intent', () => {
    const first = expand(RICH_INTENT);
    const second = expand(RICH_INTENT);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('maps roles/skills/seniority/location/exclusions to operators', () => {
    const { queries } = expand(RICH_INTENT, { families: ['ats-board'] });
    expect(queries.length).toBeGreaterThan(0);
    const q = queries[0].q;
    expect(q).toContain('"React Engineer"');
    expect(q).toContain('"TypeScript"');
    expect(q).toContain('"senior"');
    expect(q).toContain(' OR ');
    expect(q).toContain('"Berlin, Germany"');
    expect(q).toContain('-"intern"');
    expect(q.startsWith('site:')).toBe(true);
  });

  it('uses only the existing seniority vocabulary and never invents level words', () => {
    expect(SENIORITY_LEVELS).toEqual([
      'junior',
      'mid',
      'senior',
      'staff',
      'lead',
      'principal',
    ]);
    for (const level of SENIORITY_LEVELS) {
      const { queries } = expand({ roles: ['Engineer'], seniority: level as never }, { families: ['ats-board'] });
      expect(queries[0].q).toContain(`"${level}"`);
    }
    const bogus = expand(
      { roles: ['Engineer'], seniority: 'ninja-guru' as never },
      { families: ['ats-board'] },
    );
    expect(bogus.queries[0].q).not.toContain('ninja-guru');
  });

  it('reaches every DORK_TEMPLATES entry for a matching intent', () => {
    for (const template of DORK_TEMPLATES) {
      const { queries } = expand(RICH_INTENT, {
        families: [template.family],
      });
      const match = queries.filter((x) => x.templateId === template.id);
      expect(
        match.length,
        `template ${template.id} must be reachable`,
      ).toBeGreaterThan(0);
    }
  });

  it('emits only declared operator markers and declared path hints per template', () => {
    for (const template of DORK_TEMPLATES) {
      const { queries } = expand(RICH_INTENT, {
        families: [template.family],
      });
      const match = queries.filter((x) => x.templateId === template.id)[0];
      for (const marker of markersInQuery(match.q)) {
        expect(
          template.operators,
          `template ${template.id} query uses undeclared marker ${marker}: ${match.q}`,
        ).toContain(marker);
      }
      if (template.pathHints.length > 0) {
        for (const hint of template.pathHints) {
          expect(
            match.q,
            `template ${template.id} must emit declared path hint ${hint}`,
          ).toContain(hint);
        }
      } else {
        expect(
          match.q,
          `template ${template.id} declares no path hints`,
        ).not.toContain('inurl:');
      }
    }
  });

  it('caps an over-large intent at MAX_DORK_QUERIES_PER_RUN and reports the drop count', () => {
    const companies: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const n = i < 10 ? `0${i}` : `${i}`;
      companies.push(`company${n}.example`);
    }
    const result = expand({ roles: ['Engineer'], companies });
    expect(result.queries.length).toBe(MAX_DORK_QUERIES_PER_RUN);
    const nonCompanyCount = DORK_TEMPLATES.filter(
      (t) => t.family !== 'company-site',
    ).length;
    const companyTemplateCount = DORK_TEMPLATES.filter(
      (t) => t.family === 'company-site',
    ).length;
    const total = nonCompanyCount + companyTemplateCount * companies.length;
    expect(result.dropped).toBe(total - MAX_DORK_QUERIES_PER_RUN);
    expect(result.dropped).toBeGreaterThan(0);
    // Documented priority order: ats-board first, company-site last, so the
    // surviving company query is the highest-priority company.
    expect(result.queries[0].templateId).toBe(
      templateById('greenhouse-boards').id,
    );
    const last = result.queries[result.queries.length - 1];
    expect(templateById(last.templateId).family).toBe('company-site');
    expect(last.site).toBe('company01.example');
  });

  it('honours a user site: operator verbatim without double-applying', () => {
    const result = expand({
      query: 'site:example.com engineer',
      roles: ['Engineer'],
    });
    expect(result.queries.length).toBeGreaterThan(0);
    for (const query of result.queries) {
      expect(query.q).toContain('site:example.com');
      expect(query.q.match(/site:/g)?.length).toBe(1);
      expect(query.site).toBeUndefined();
    }
  });

  it('honours a user -term verbatim without appending intent exclusions', () => {
    const result = expand({
      query: '"Engineer" -senior',
      exclusions: ['intern'],
    });
    expect(result.queries.length).toBeGreaterThan(0);
    for (const query of result.queries) {
      expect(query.q).toContain('-senior');
      expect(query.q).not.toContain('intern');
    }
  });

  it('yields only generic families and fabricates no company term for an empty intent', () => {
    const result = expand({});
    expect(result.queries.length).toBeGreaterThan(0);
    expect(result.dropped).toBe(0);
    for (const query of result.queries) {
      const family = templateById(query.templateId).family;
      expect(['career-page', 'job-index']).toContain(family);
      expect(query.q).not.toContain('site:');
      expect(query.site).toBeUndefined();
    }
    const haystack = result.queries.map((x) => x.q).join(' ');
    for (const word of ['acme', 'globex', 'initech', 'umbrella']) {
      expect(haystack.toLowerCase()).not.toContain(word);
    }
  });

  it('truncates over-long queries at the named character cap and records it', () => {
    expect(MAX_DORK_QUERY_CHARS).toBeGreaterThan(0);
    const longRole = `Role ${'x'.repeat(95)}`;
    const result = expand({
      roles: [longRole, `${longRole} 2`, `${longRole} 3`],
      skills: [`${longRole} 4`, `${longRole} 5`],
      locations: [`${longRole} 6`],
      exclusions: [`${longRole} 7`],
    });
    expect(result.truncated).toBeGreaterThan(0);
    for (const query of result.queries) {
      expect(query.q.length).toBeLessThanOrEqual(MAX_DORK_QUERY_CHARS);
    }
    const small = expand({ roles: ['Engineer'] });
    expect(small.truncated).toBe(0);
  });

  it('sets maxResults from the named per-query constant on every query', () => {
    const result = expand(RICH_INTENT);
    expect(result.queries.length).toBeGreaterThan(0);
    for (const query of result.queries) {
      expect(query.maxResults).toBe(MAX_DORK_RESULTS_PER_QUERY);
    }
  });

  it('ignores unknown families and emits company-site only with companies', () => {
    const unknown = expand(RICH_INTENT, { families: ['nope'] });
    expect(unknown.queries).toEqual([]);
    expect(unknown.dropped).toBe(0);
    const noCompanies = expand({ roles: ['Engineer'] });
    for (const query of noCompanies.queries) {
      expect(templateById(query.templateId).family).not.toBe('company-site');
    }
    expect(noCompanies.dropped).toBe(0);
  });
});
