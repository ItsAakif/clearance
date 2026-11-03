// Shared seniority vocabulary (leaf module).
//
// `seniorityEnum` used to live in `shared/validation.ts`, but wave 7's
// `discovery/searchIntent.ts` imports it while wave 12's
// `shared/validation.ts` must import wave 7's `searchIntentSchema` back - a
// direct import in both directions crashes at load time (the schema that
// evaluates first reads an uninitialised binding). Keeping the enum in this
// dependency-free leaf breaks the cycle: both consumers import it from here,
// and `shared/validation.ts` re-exports it so every existing import site
// keeps working unchanged.

import { z } from 'zod';

export const seniorityEnum = z.enum(['junior', 'mid', 'senior', 'staff', 'lead', 'principal']);
