// ImportResumeDialog.tsx - "Import from a resume" in the Studio top bar.
//
// THE IMPORT IS HONEST ABOUT WHAT IT DID. `POST /career/import/resume` runs the
// deterministic parser first and only uses a configured AI provider as an optional second
// pass. Nothing it writes is confirmed: every claim is `inferred`, and the projector only
// places confirmed claims, so importing cannot silently put a sentence on the page.
// The result is shown as the server reported it - created/deduped/extracted counts, which
// parser ran, and the enrichment outcome. There is no upload progress bar: the useful
// state is "parsing" and then the result, and a fake percentage would be neither.

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Upload } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ApiClientError } from '@/services/api/client';
import { careerApi, type CareerImportResult } from '@/services/api/career';
import { enrichmentMessage } from '@/features/career/claimPresentation';

const ACCEPTED = '.pdf,.docx,.txt';

function parserLabel(result: CareerImportResult): string {
  if (result.enrichment.status === 'applied') {
    return `AI pass (${result.enrichment.provider}) after the deterministic parser`;
  }
  return 'Deterministic parser';
}

function importErrorMessage(caught: unknown): string {
  if (!(caught instanceof ApiClientError)) {
    return 'The import could not be completed. Nothing was changed.';
  }
  const code = caught.code ?? '';
  if (code === 'interview_provider_required' || code.endsWith('provider_required')) {
    // The deterministic import does not need a provider. Say that plainly instead of
    // repeating the AI stage's refusal as though the whole import failed.
    return `${caught.message} The AI pass needs a provider; the deterministic parser does not. Nothing was confirmed.`;
  }
  return caught.code ? `${caught.message} (${caught.code})` : caught.message;
}

export function ImportResumeDialog() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CareerImportResult | null>(null);

  const reset = () => {
    setFile(null);
    setBusy(false);
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await careerApi.importResume(file));
    } catch (caught) {
      setError(importErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const openProfile = () => {
    onOpenChange(false);
    navigate('/app/profile');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Import resume
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md" data-testid="studio-import-dialog">
        <DialogHeader>
          <DialogTitle>Import from a resume</DialogTitle>
          <DialogDescription>
            Statements are imported as inferred. Nothing is confirmed for you; confirm them in
            Profile before they can appear on a resume.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <Alert data-testid="studio-import-result">
              <AlertTitle>
                {result.claims.created} imported, {result.claims.deduped} skipped
              </AlertTitle>
              <AlertDescription className="space-y-1">
                <p>
                  {result.claims.extracted} statement
                  {result.claims.extracted === 1 ? '' : 's'} read from the file. Parser:{' '}
                  {parserLabel(result)}.
                </p>
                {enrichmentMessage(result.enrichment) ? (
                  <p>{enrichmentMessage(result.enrichment)}</p>
                ) : null}
                <p>{result.note}</p>
                <p>
                  No resume was created. Imported statements are inferred; only confirmed
                  statements are placed by the projector.
                </p>
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={openProfile}>Open Profile to confirm</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <label htmlFor="studio-import-file" className="block text-xs2 font-medium text-ink-2">
                Resume file (PDF, DOCX or TXT)
              </label>
              <Input
                id="studio-import-file"
                ref={inputRef}
                type="file"
                accept={ACCEPTED}
                disabled={busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setError(null);
                }}
              />
            </div>

            <p className="text-sm text-ink-3">
              The deterministic parser reads the file with no AI provider. A configured provider
              may add a second pass. Importing does not create a resume, and only confirmed
              statements can appear on one.
            </p>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Import failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={busy || file === null} onClick={() => void submit()}>
                {busy ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Upload className="mr-1.5 h-4 w-4" aria-hidden="true" />
                )}
                {busy ? 'Parsing' : 'Import'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ImportResumeDialog;
