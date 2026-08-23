import { describe, it, expect } from 'vitest';
import { validateUploadedFile, normalizeDate, resumeToMarkdown, type ParsedResume } from './parser.js';

describe('validateUploadedFile', () => {
  it('accepts a small PDF', () => {
    expect(() => validateUploadedFile(Buffer.from('x'), 'application/pdf', 'r.pdf')).not.toThrow();
  });
  it('rejects oversized files', () => {
    expect(() => validateUploadedFile(Buffer.alloc(11 * 1024 * 1024), 'application/pdf', 'r.pdf')).toThrow();
  });
  it('rejects disallowed mime types', () => {
    expect(() => validateUploadedFile(Buffer.from('x'), 'image/png', 'r.png')).toThrow();
  });
  it('rejects dangerous extensions', () => {
    expect(() => validateUploadedFile(Buffer.from('x'), 'text/plain', 'evil.exe')).toThrow();
  });
});

describe('normalizeDate', () => {
  it('maps "Present" -> Present', () => expect(normalizeDate('Present')).toBe('Present'));
  it('normalizes "Jan 2020" -> 2020-01', () => expect(normalizeDate('Jan 2020')).toBe('2020-01'));
  it('keeps a bare year', () => expect(normalizeDate('2019')).toBe('2019'));
  it('returns empty for blank', () => expect(normalizeDate('')).toBe(''));
});

describe('resumeToMarkdown', () => {
  it('renders name, skills, and sections', () => {
    const p: ParsedResume = {
      personalInfo: { fullName: 'Jane Doe', email: 'j@x.com', phone: '', location: '', linkedin: '', website: '' },
      summary: 'Engineer',
      experience: [],
      education: [],
      projects: [],
      skills: ['TypeScript'],
      languages: [],
      rawText: ''
    };
    const md = resumeToMarkdown(p);
    expect(md).toContain('# Jane Doe');
    expect(md).toContain('## Skills');
    expect(md).toContain('TypeScript');
  });
});
