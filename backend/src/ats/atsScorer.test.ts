import { describe, it, expect } from 'vitest';
import { scoreResumeAgainstJob, extractJdKeywords } from './atsScorer.js';

const jd =
  'We need a Senior Software Engineer with React, TypeScript, Node.js and AWS. Strong communication skills required.';

describe('extractJdKeywords', () => {
  it('returns frequency-ranked non-stopwords', () => {
    const k = extractJdKeywords('React React TypeScript AWS aws', 10);
    expect(k).toContain('react');
    expect(k).toContain('typescript');
    expect(k).not.toContain('the');
  });
});

describe('scoreResumeAgainstJob', () => {
  it('scores higher when resume contains JD terms', () => {
    const good = scoreResumeAgainstJob({
      resumeText: 'I have React, TypeScript, Node.js and AWS experience.',
      skills: ['React', 'TypeScript'],
      jd,
    });
    const bad = scoreResumeAgainstJob({
      resumeText: 'I enjoy painting and music.',
      skills: ['Painting'],
      jd,
    });
    expect(good.overall).toBeGreaterThan(bad.overall);
    expect(good.keywordMatch.score).toBeGreaterThan(0);
  });

  it('computes skills coverage as fraction of resume skills evidenced in JD', () => {
    const r = scoreResumeAgainstJob({
      resumeText: 'React TypeScript Node AWS',
      skills: ['React', 'TypeScript', 'Go'],
      jd: 'React and TypeScript required',
    });
    // React + TypeScript (2 of 3) are in the JD
    expect(r.skillsCoverage.score).toBe(Math.round((2 / 3) * 100));
  });

  it('section completeness rewards present sections', () => {
    const full = scoreResumeAgainstJob({
      resumeText: 'Summary of me. Experience working. Education degree. Skills: a,b.',
      skills: ['x'],
      jd: 'needs react',
    });
    const empty = scoreResumeAgainstJob({ resumeText: 'react', skills: [], jd: 'needs react' });
    expect(full.sectionCompleteness.score).toBeGreaterThanOrEqual(empty.sectionCompleteness.score);
  });

  it('overall is the 0.55/0.25/0.20 weighted sum', () => {
    const r = scoreResumeAgainstJob({
      resumeText: 'React TypeScript Node AWS communication',
      skills: ['React', 'TypeScript'],
      jd,
    });
    const expected = Math.round(
      0.55 * r.keywordMatch.score + 0.25 * r.skillsCoverage.score + 0.2 * r.sectionCompleteness.score
    );
    expect(r.overall).toBe(expected);
    expect(r.weights).toEqual({ keywordMatch: 0.55, skillsCoverage: 0.25, sectionCompleteness: 0.2 });
  });
});
