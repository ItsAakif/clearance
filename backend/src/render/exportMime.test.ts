// The export content-type table - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 7
//                 .planning/decisions/ADR-042-latex-export-only-and-broker.md D1
// Task:         T1044

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ARTIFACT_MIME_TYPES } from './stage.js';
import { EXPORT_FORMATS, EXPORT_MIME_TYPES, exportMimeType, isExportFormat } from './exportMime.js';

const MODULE_SOURCE = readFileSync(path.join(__dirname, 'exportMime.ts'), 'utf8');

describe('EXPORT_MIME_TYPES', () => {
  it('is exactly the two export formats, with the pinned content types', () => {
    expect(EXPORT_FORMATS).toEqual(['tex', 'json']);
    expect(EXPORT_MIME_TYPES).toEqual({
      tex: 'application/x-tex',
      json: 'application/json',
    });
    expect(Object.isFrozen(EXPORT_MIME_TYPES)).toBe(true);
    expect(Object.isFrozen(EXPORT_FORMATS)).toBe(true);
  });

  it('declares NO typst type, because a .typ export is refused before it can be served', () => {
    // T1040 sec. 11 open item 1, ruled in sec. 13 ruling 1 as (c) KEEP REFUSING. A `.typ`
    // export is a BUNDLE (template + data.json + packages.lock), and the route refuses it
    // with 422 `render_format_unsupported` / `TYP_EXPORT_IS_A_BUNDLE`. Declaring a content
    // type here would be the first step of shipping the bundle shape.
    expect(Object.keys(EXPORT_MIME_TYPES)).not.toContain('typ');
    expect(EXPORT_FORMATS as readonly string[]).not.toContain('typ');
    expect(EXPORT_MIME_TYPES).not.toHaveProperty('typ');
  });

  it('keeps compile ARTIFACTS out of the export table', () => {
    // Two questions, two tables: `ARTIFACT_MIME_TYPES` answers "what are the bytes of a
    // finished compile?", this one answers "what do we hand the user when nothing was
    // compiled?". Merging them would let a later edit type an export as a compile output.
    expect(Object.keys(ARTIFACT_MIME_TYPES).sort()).toEqual(['pdf', 'png', 'svg']);
    for (const format of Object.keys(ARTIFACT_MIME_TYPES)) {
      expect(Object.keys(EXPORT_MIME_TYPES)).not.toContain(format);
    }
    // ...and no value is shared, so there is nothing to keep in sync by accident.
    const shared = Object.values(ARTIFACT_MIME_TYPES).filter((value) =>
      Object.values(EXPORT_MIME_TYPES).includes(value),
    );
    expect(shared).toEqual([]);
  });

  it('isExportFormat narrows the closed vocabulary and nothing else', () => {
    for (const format of EXPORT_FORMATS) {
      expect(isExportFormat(format)).toBe(true);
      expect(exportMimeType(format)).toBe(EXPORT_MIME_TYPES[format]);
    }
    for (const value of ['typ', 'pdf', '', 'TEX', 'json ', null, undefined, 42, {}]) {
      expect(isExportFormat(value), `${String(value)} passed the guard`).toBe(false);
    }
  });

  it('exportMimeType refuses an unknown format with a FIXED reason and no caller data', () => {
    // Policy 9.3/9.4: an error message never interpolates the caller's value, so a hostile
    // format string cannot smuggle content into a log line or an error body.
    for (const value of ['typ', 'pdf', '<script>', '']) {
      expect(() => exportMimeType(value as never), `${value} was accepted`).toThrow(
        'RENDER_EXPORT_FORMAT_UNKNOWN: export format must be one of tex, json',
      );
    }
    try {
      exportMimeType('typ' as never);
    } catch (error) {
      expect(String(error)).not.toContain('typ');
    }
  });

  it('the module imports nothing: a content-type table is data', () => {
    const code = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const specifiers = [...code.matchAll(/(?:from|import|require\()\s*'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers).toEqual([]);
    for (const instrument of ['readFile', 'writeFile', 'fetch(', 'process.env', 'Date.now']) {
      expect(code).not.toContain(instrument);
    }
  });
});