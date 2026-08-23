// Tiny, dependency-free prompt loader for the ATS evaluator.
// Loads version-controlled .jinja templates and renders {{ variable }} placeholders.
// Kept minimal + provider-agnostic so prompts can be audited and edited without touching code.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// __dirname is available both when compiled to CJS and under tsx (which shims it).
const PROMPTS_DIR = join(__dirname, 'prompts');

export type PromptVars = Record<string, string>;

/**
 * Render a template string with {{ var }} substitutions.
 * Unknown variables are left as empty strings to avoid throwing on optional context.
 */
export function renderTemplate(template: string, vars: PromptVars): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Load a .jinja template from the prompts directory and render it with vars. */
export function loadAndRender(name: string, vars: PromptVars = {}): string {
  const filePath = join(PROMPTS_DIR, name.endsWith('.jinja') ? name : `${name}.jinja`);
  const template = readFileSync(filePath, 'utf-8');
  return renderTemplate(template, vars);
}
