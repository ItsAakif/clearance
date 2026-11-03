// The import wizard (T1020, 06 E.11 flow 1).
//
// Drop a resume or notes file -> we show what we extracted as CANDIDATE claims, every one
// of them UNCONFIRMED, and hand the user to the verification list. The wizard's job is to
// be honest about that last part in three places, because the whole product promise is
// that an inference never silently becomes experience:
//
//   1. BEFORE the import: the copy says the statements arrive unconfirmed.
//   2. IN THE RESULT: the enrichment report is shown verbatim, including the
//      "no AI provider configured" case, which is NOT an error - the deterministic import
//      completed and saying so is more useful than hiding the step.
//   3. IN THE COUNTS: `statusAssigned` is echoed from the server, so the page can state
//      what status the rows actually carry rather than what the UI hoped they would.
//
// It reuses the app's own primitives (`Card`, `Button`, `Alert`, `Progress`) and
// `StepIndicator`, the same stepper the AI build flow uses, so the import reads as the
// first step of a process rather than a standalone form.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Upload } from "lucide-react";
import StepIndicator from "@/components/animations/StepIndicator";
import { careerApi, type CareerImportResult } from "@/services/api/career";
import { ApiClientError } from "@/services/api/client";
import type { UploadedFileSummary } from "@/services/api/resume";
import { IMPORT_WIZARD_STEPS, enrichmentMessage } from "./claimPresentation";

const ACCEPTED = ".pdf,.docx,.doc,.txt,text/plain,application/pdf";

interface ImportWizardProps {
  profileId?: string | null;
  /** Files the user already uploaded, offered so nobody has to upload twice. */
  uploadedFiles?: readonly UploadedFileSummary[];
  onImported: (result: CareerImportResult) => void;
}

export function ImportWizard({ profileId, uploadedFiles, onImported }: ImportWizardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploadedFileId, setUploadedFileId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CareerImportResult | null>(null);

  const canSubmit = busy || (file !== null || uploadedFileId.trim().length > 0);

  async function submit(): Promise<void> {
    if (file === null && uploadedFileId.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const options = profileId ? { profileId } : {};
      const imported =
        file !== null
          ? await careerApi.importResume(file, options)
          : await careerApi.importUploadedFile(uploadedFileId.trim(), options);
      setResult(imported);
      onImported(imported);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'The import could not be completed. Your profile was not changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-4 w-4" aria-hidden="true" />
          Import a resume or notes file
        </CardTitle>
        <CardDescription>
          We read the file and list what we found as candidate statements. Every one of
          them starts unconfirmed, and nothing can enter a resume until you confirm it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <StepIndicator currentStep={2} totalSteps={IMPORT_WIZARD_STEPS} />

        <div className="space-y-2">
          <Label htmlFor="career-import-file" className="text-sm">
            Resume file (PDF, DOCX or TXT)
          </Label>
          <Input
            id="career-import-file"
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            disabled={busy || uploadedFileId.trim().length > 0}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>

        {uploadedFiles && uploadedFiles.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor="career-import-existing" className="text-sm">
              ...or use a file you already uploaded
            </Label>
            <select
              id="career-import-existing"
              className="h-9 w-full rounded-control border border-rule bg-paper px-3 text-sm"
              value={uploadedFileId}
              disabled={busy || file !== null}
              onChange={(event) => setUploadedFileId(event.target.value)}
            >
              <option value="">Choose an uploaded file</option>
              {uploadedFiles.map((uploaded) => (
                <option key={uploaded.id} value={uploaded.id}>
                  {uploaded.fileName}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={submit} disabled={!canSubmit || busy}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {busy ? 'Importing' : 'Import and review'}
          </Button>
          {file !== null || uploadedFileId.trim().length > 0 ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setFile(null);
                setUploadedFileId('');
                setResult(null);
                setError(null);
                if (inputRef.current) inputRef.current.value = '';
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Import failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {result ? (
          <Alert data-testid="career-import-result">
            <AlertTitle>
              {result.claims.created > 0
                ? `${result.claims.created} statement${result.claims.created === 1 ? '' : 's'} found, all unconfirmed`
                : 'Nothing new to add - this file was already imported'}
            </AlertTitle>
            <AlertDescription className="space-y-1">
              <p>
                {result.claims.extracted} read from the file, {result.claims.created} new,{' '}
                {result.claims.deduped} already on file. Source: {result.evidenceSource}{' '}
                record.
              </p>
              <p>Every statement carries status &quot;{result.statusAssigned}&quot; and provenance &quot;{result.provenanceAssigned}&quot;.</p>
              {enrichmentMessage(result.enrichment) ? <p>{enrichmentMessage(result.enrichment)}</p> : null}
              <p>{result.note}</p>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default ImportWizard;
