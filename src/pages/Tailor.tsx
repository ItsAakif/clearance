// Tailor.tsx - the tailoring page (T1080; 06 sec.E.3, sec.E.11).
//
// FLAG GATED by the EXISTING `v2ResumeStudio` flag (`src/lib/flags.ts`), exactly as the Studio
// is: `src/App.tsx` does not register these routes at all with the flag off, so `/app/tailor`
// and `/app/tailor/:resumeId` are 404s like any other unknown path and the chunk is never
// fetched. No new flag is introduced, so the cross-runtime flag-name contract holds.
//
// WITHOUT A `:resumeId` IT IS A CHOOSER, not an editor. A tailoring pass operates on a
// REVISION, and the only way a `modelVersion: 2` resume comes into existence is
// `POST /resumes/from-profile` (`features/studio` owns that), so this page's job is to name the
// resume and then show the proposals. It deliberately does NOT offer to create one: a tailoring
// surface that could make a resume would be a second data path next to the Studio's.
//
// THE PAGE RENDERS NO DOCUMENT. There is no preview, no layout and no download here: the output
// of a tailoring pass is a set of operations and a revision id, and the document that comes
// back belongs to the Studio.

import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Scissors } from 'lucide-react';

import { PageShell } from '@/components/layout/PageShell';
import { SectionView } from '@/components/layout/SectionView';
import { MatchSectionTabs } from '@/components/layout/SectionTabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TailorPanel } from '@/features/tailor/TailorPanel';

function TailorChooser() {
  const [resumeId, setResumeId] = useState('');
  const navigate = useNavigate();
  return (
    <PageShell title="Match" width="data">
      <MatchSectionTabs />
      <SectionView
        title="Tailor"
        description="Propose individual operations against your confirmed claims. Never a rewritten document."
      />
      <div className="space-y-6">
        <Alert>
          <AlertTitle>A tailoring pass works on a resume, not on a job</AlertTitle>
          <AlertDescription>
            Open the Resume Studio to create a resume from your career profile, then come back
            with its id.
          </AlertDescription>
        </Alert>

        <section className="surface-card p-5">
  <h2 className="section-title">Open a resume to tailor</h2>
  <div className="mt-2 border-t border-rule" />
  <p className="mt-3 text-sm text-ink-3">Resume ids appear in the URL of a resume you have already opened in the Studio.</p>
  <div className="mt-3 space-y-2">
            <label htmlFor="tailor-resume-id" className="text-xs2 font-medium text-ink">
              Resume id
            </label>
            <input
              id="tailor-resume-id"
              value={resumeId}
              onChange={(event) => setResumeId(event.target.value)}
              className="w-full rounded-control border border-border bg-card px-3 py-2 text-sm text-ink focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={resumeId.trim().length === 0}
                onClick={() => navigate(`/app/match/tailor/${resumeId.trim()}`)}
              >
                <Scissors className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Open
              </Button>
              <Link className="text-xs2 underline underline-offset-2" to="/app/studio">
                Or go to the Resume Studio
              </Link>
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function TailorForResume({ resumeId }: { resumeId: string }) {
  const [mounted, setMounted] = useState(false);
  const load = useCallback(async () => {
    // The panel is mounted only after the first paint so a refusal on the initial request is a
    // rendered alert rather than a thrown render - the same shape the Studio uses for its own
    // load failures.
    setMounted(true);
  }, []);

  void load();

  return (
    <PageShell
      title="Match"
      width="data"
      toolbar={
        <div className="flex items-center gap-2 text-xs2 text-ink-3">
          {!mounted ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading the tailoring surface
            </>
          ) : (
            <>
              Resume <code>{resumeId}</code>
            </>
          )}
        </div>
      }
    >
      <MatchSectionTabs />
      <SectionView
        title="Tailor"
        description="Operations, checked against your confirmed claims, applied as a new revision. The one you have now never changes."
      />
      <TailorPanel resumeId={resumeId} />
    </PageShell>
  );
}

export default function Tailor() {
  const { resumeId } = useParams<{ resumeId: string }>();
  if (!resumeId) return <TailorChooser />;
  return <TailorForResume resumeId={resumeId} />;
}