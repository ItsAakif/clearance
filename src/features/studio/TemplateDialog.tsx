// TemplateDialog.tsx - 06 E.11 flow 5, moved out of the editor and into a compact dialog.
//
// THE TEMPLATE IS A RENDER-TIME CHOICE AND NEVER TOUCHES THE DOCUMENT. That is the acceptance
// item, and the mechanism is structural rather than a promise: the document writer in
// `blockModel.ts` takes no template and no layout input of any kind, so there is no channel
// through which a selection could reach the resume JSON. `templateSwitch.test.ts` asserts both
// halves - the writer's arity, and that two serializations around a template switch are
// byte-identical.
//
// WHY A DIALOG. The old `TemplateSwitch` was a seven-row stack above the editor, which is half
// of what made the Studio feel like a settings page with a resume attached. The picker is now a
// two-column grid behind the top bar's `Template: <name>` button. The selection is still made on
// a radio and confirmed with `Use this template`, so opening the picker is not a render request.
//
// NO FAKE THUMBNAILS. `thumbnail: null` is what the registry ships (T1040 ruling sec.13.2 - a
// raster render of a multi-page resume is a second artifact, which the sandbox policy refuses),
// so each option carries a neutral page mark with the template's real metadata. It is a shape on
// a page, not a picture of a layout this page has not rendered.

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Columns2, LayoutTemplate, Rows3 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import {
  DEFAULT_TEMPLATE_ID,
  STUDIO_TEMPLATES,
  findTemplate,
  pageSizeLabel,
  templateUnsupportedMessage,
  type StudioTemplate,
} from './templates';

export interface TemplateDialogProps {
  /** The selected template id. Held by the page; it is never written into the document. */
  value: string;
  onChange: (templateId: string) => void;
  /** The refusal code the last render returned, when the server refused the selection. */
  refusalCode?: string | null;
}

/** A neutral page mark. Never a fake image of a layout this page has not rendered. */
function TemplateThumb({ template }: { template: StudioTemplate }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-16 w-12 shrink-0 flex-col gap-1 rounded-[3px] border border-rule bg-paper p-1.5 shadow-e1"
    >
      <span className="h-1 w-3/4 rounded-full bg-ink/15" />
      <span className="h-px w-full rounded-full bg-rule" />
      <span className="h-px w-5/6 rounded-full bg-rule" />
      <span className="h-px w-full rounded-full bg-rule" />
      <span className="mt-auto text-[9px] leading-none text-ink-3">
        {pageSizeLabel(template.pageSize)}
      </span>
    </span>
  );
}

export function TemplateDialog({ value, onChange, refusalCode }: TemplateDialogProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const selected = findTemplate(value) ?? STUDIO_TEMPLATES[0];
  const unsupported = refusalCode === 'render_template_unsupported';

  // Opening the picker starts from what the page is actually rendering with, not from the last
  // draft the user abandoned. Closing without confirming therefore changes nothing.
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="max-w-[240px]"
          aria-label={`Template: ${selected.label}`}
        >
          <LayoutTemplate className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate">Template: {selected.label}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Template</DialogTitle>
          <DialogDescription>
            The template decides how the same content is laid out on the page. It is a
            render-time choice: your document, its revision and its hash are unchanged when you
            switch, and each template produces its own artifact.
          </DialogDescription>
        </DialogHeader>

        {unsupported ? (
          <Alert>
            <AlertTitle className="flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              The server would not use this template
            </AlertTitle>
            <AlertDescription>{templateUnsupportedMessage(value, DEFAULT_TEMPLATE_ID)}</AlertDescription>
          </Alert>
        ) : null}

        <RadioGroup
          value={draft}
          onValueChange={setDraft}
          aria-label="Resume template"
          className="grid gap-3 sm:grid-cols-2"
        >
          {STUDIO_TEMPLATES.map((template) => {
            const checked = template.id === draft;
            const current = template.id === value;
            const id = `template-card-${template.id}`;
            return (
              <label
                key={template.id}
                htmlFor={id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-control border p-3 transition-colors duration-150 ease-out',
                  checked
                    ? 'border-primary bg-accent-soft'
                    : 'border-rule bg-card hover:bg-paper-2',
                )}
              >
                <TemplateThumb template={template} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-ink">{template.label}</span>
                    <RadioGroupItem value={template.id} id={id} className="mt-0.5" />
                  </div>
                  <p className="mt-1 text-xs2 leading-snug text-ink-3">{template.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge variant={template.atsFriendly ? 'default' : 'outline'} className="text-[10px]">
                      {template.atsFriendly ? 'ATS' : 'Not ATS'}
                    </Badge>
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      {template.columns === 2 ? (
                        <Columns2 className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Rows3 className="h-3 w-3" aria-hidden="true" />
                      )}
                      {template.columns} column{template.columns === 1 ? '' : 's'}
                    </Badge>
                    {current ? (
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <Check className="h-3 w-3" aria-hidden="true" />
                        Current
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </label>
            );
          })}
        </RadioGroup>

        <DialogFooter>
          <p className="mr-auto text-left text-xs2 text-ink-3">
            Choosing a template changes the rendered artifact, not the document.
          </p>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onChange(draft);
              setOpen(false);
            }}
          >
            Use this template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TemplateDialog;
