// Live compile of the LaTeX exporter's output in the pinned worker image.
//
// WHY THIS FILE IS UNDER `render/broker/`. G1's repo-wide gate forbids a
// `child_process` import outside this path segment, and a real compile needs to invoke
// the docker CLI. Keeping the test here means the gate keeps its subject set unchanged
// rather than gaining a second exception.
//
// IT SKIPS, WITH A NAMED REASON, WHEN THE IMAGE IS NOT PRESENT. A contributor who has not
// run `docker compose build latex-worker` must still be able to run the unit suite. The
// image's presence is the ONLY condition: when it exists this is a real `pdflatex`
// compile with the policy argv, the policy env and the policy isolation keys, and it
// fails if the exporter's output stops compiling.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectResumeDict } from '../dict.js';
import { renderLatexExportBytes } from '../latexExport.js';
import { LATEX_PIN, REQUIRED_TMPFS, buildCompileArgs } from '../sandbox.js';

const IMAGE = `clearance/latex-worker:${LATEX_PIN.version}`;

/** Is the pinned image present on THIS host? `docker image inspect` in one synchronous call. */
const imageProbe = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' });
const imagePresent = imageProbe.status === 0;

const SKIP_REASON = `the pinned ${IMAGE} image is not present on this host (build it with "docker compose build latex-worker")`;

function dockerArgsFor(inDir: string, outDir: string): string[] {
  const plan = buildCompileArgs('latex', { creationTimestampUnix: 1_757_000_000 });
  const args: string[] = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '64',
    '--memory',
    '1073741824',
    '--memory-swap',
    '1073741824',
    '--cpus',
    '1',
  ];
  for (const tmpfs of REQUIRED_TMPFS) args.push('--tmpfs', tmpfs);
  // TEST-ONLY binds: the input tree and a place to copy the result out. The product
  // path never binds a host directory (the broker streams a tar into `/work`).
  args.push('--mount', `type=bind,source=${inDir},target=/in,readonly`);
  args.push('--mount', `type=bind,source=${outDir},target=/outhost`);
  for (const key of Object.keys(plan.env).sort()) {
    args.push('--env', `${key}=${plan.env[key] as string}`);
  }
  args.push('--workdir', '/work');
  args.push('--entrypoint', '/bin/sh');
  args.push(IMAGE);
  args.push(
    '-c',
    `cp /in/artifact.tex /work/artifact.tex && /opt/latex/pdflatex ${plan.argv
      .slice(1)
      .map((token) => (token.includes(' ') ? `'${token}'` : token))
      .join(' ')} >/dev/null 2>&1 && cp /out/artifact.pdf /outhost/artifact.pdf`,
  );
  return args;
}

describe.skipIf(!imagePresent)(`live: ${IMAGE} compiles the exporter output`, () => {
  it('produces a %PDF- artifact under the policy argv/env', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'clearance-latex-live-'));
    try {
      const inDir = path.join(root, 'in');
      const outDir = path.join(root, 'out');
      mkdirSync(inDir);
      mkdirSync(outDir);
      const document = renderLatexExportBytes(
        projectResumeDict({
          basics: {
            name: 'Ada Lovelace',
            label: 'Staff Engineer',
            email: 'ada@example.com',
            summary: 'Mathematician.',
          },
          work: [
            {
              name: 'Analytical Engines',
              position: 'Staff Engineer',
              startDate: '1842-01',
              highlights: ['Wrote the first algorithm'],
            },
          ],
        }),
      );
      writeFileSync(path.join(inDir, 'artifact.tex'), document);

      const result = spawnSync('docker', dockerArgsFor(inDir, outDir), {
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(result.error, String(result.error ?? '')).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const pdfPath = path.join(outDir, 'artifact.pdf');
      expect(existsSync(pdfPath), 'the image produced no /out/artifact.pdf').toBe(true);
      const pdf = readFileSync(pdfPath);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

// Emit the named reason even when the test is skipped, so a CI log says WHY rather than
// leaving an unexplained skip.
if (!imagePresent) {
  // eslint-disable-next-line no-console
  console.warn(`SKIP latexWorkerLive: ${SKIP_REASON}`);
}
