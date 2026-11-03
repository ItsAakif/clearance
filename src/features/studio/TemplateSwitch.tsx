// TemplateSwitch.tsx - 06 E.11 flow 5, reduced to what is honest today (T1050).
//
// THE TEMPLATE IS A RENDER-TIME CHOICE AND NEVER TOUCHES THE DOCUMENT. That is the
// acceptance item, and the mechanism is structural rather than a promise: the document writer
// in `blockModel.ts` takes no template and no layout input of any kind, so there is no channel
// through which a selection could reach the resume JSON. `templateSwitch.test.ts` asserts both
// halves - the writer's arity, and that two serializations around a template switch are
// byte-identical.
//
// WHAT THIS COMPONENT DOES NOT DO. It does not claim the switch changed anything about the
// resume. The render request carries the chosen `templateId`, so the typesetter lays the SAME
// revision out with THAT template - but the document, the revision and its hash are identical
// either way, and `templateSwitch.test.ts` asserts both halves: the writer takes no template,
// and two serializations around a switch are byte-identical.
//
// IT ALSO DOES NOT HIDE A REFUSAL. `POST /resumes/:id/render` answers 422
// `render_template_unsupported` for a template the registry cannot resolve - a reserved id, an
// id that is not in the registry, or a value that is not a template id at all. When that comes
// back, this component says so in the machine's own words rather than implying a layout
// changed. It is a refusal of an UNUSABLE id now, not a blanket refusal of per-request
// templates (T1050 escalation 1 widened the render seam; the Studio's list is cross-checked
// against the registry by `templateSwitch.test.ts`, so a user should never see it).
//
// NO THUMBNAILS. `thumbnail: null` is what the registry ships (T1040 ruling sec.13.2 - a raster
// render of a multi-page resume is a second artifact, which the sandbox policy refuses), so
// each option carries the template's REAL metadata in a ruled row and a neutral page mark: a
// blank page proportion, never a fake picture of a layout this page has not rendered.

import { AlertTriangle, Columns2, FileText, Rows3 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import {
  DEFAULT_TEMPLATE_ID,
  STUDIO_TEMPLATES,
  findTemplate,
  pageSizeLabel,
  templateUnsupportedMessage,
  type StudioTemplate,
} from './templates';

export interface TemplateSwitchProps {
  /** The selected template id. Held by the page; it is never written into the document. */
  value: string;
  onChange: (templateId: string) => void;
  /**
   * The refusal code the last render returned, when the server refused the selection.
   * `null` while no render has been attempted.
   */
  refusalCode?: string | null;
}

/** The neutral placeholder. Never a fake image of a layout this page has not rendered. */
function TemplatePlaceholder({ template }: { template: StudioTemplate }) {
  return (
    <div
      aria-hidden="true"
      className="flex h-12 w-10 shrink-0 items-end justify-center rounded-control border border-rule bg-paper-2 px-1 py-0.5"
    >
      <span className="text-xs leading-none text-ink-3">{pageSizeLabel(template.pageSize)}</span>
    </div>
  );
}

export function TemplateSwitch({ value, onChange, refusalCode }: TemplateSwitchProps) {
  const unsupported = refusalCode === 'render_template_unsupported';
  const selected = findTemplate(value) ?? STUDIO_TEMPLATES[0];

  return (
    <div className="space-y-3" data-testid="studio-template-switch">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="section-label">Template</h3>
        <span className="text-xs2 text-ink-3">Showing {selected.label}</span>
      </div>
      <div className="border-t border-rule" />
      <p className="text-sm text-ink-3">
        The template decides how the same content is laid out on the page. It is a render-time
        choice: your document, its revision and its hash are unchanged when you switch, and each
        template produces its own artifact.
      </p>

      {unsupported ? (
        <Alert>
          <AlertTitle className="flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            The server would not use this template
          </AlertTitle>
          <AlertDescription>
            {templateUnsupportedMessage(value, DEFAULT_TEMPLATE_ID)}
          </AlertDescription>
        </Alert>
      ) : null}

      <RadioGroup
        value={value}
        onValueChange={onChange}
        aria-label="Resume template"
        className="divide-y divide-rule"
      >
        {STUDIO_TEMPLATES.map((template) => {
          return (
            <div key={template.id} className="flex items-start gap-3 py-2.5">
              <TemplatePlaceholder template={template} />
              <RadioGroupItem value={template.id} id={`template-${template.id}`} className="mt-1" />
              <div className="min-w-0 flex-1">
                <Label htmlFor={`template-${template.id}`} className="text-sm font-medium text-ink">
                  {template.label}
                </Label>
                <p className="mt-0.5 text-xs2 text-ink-3">{template.description}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs2 text-ink-3">
                  <span className="inline-flex items-center gap-1">
                    {template.columns === 2 ? (
                      <Columns2 className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Rows3 className="h-3 w-3" aria-hidden="true" />
                    )}
                    {template.columns} column{template.columns === 1 ? '' : 's'}
                  </span>
                  <span>{pageSizeLabel(template.pageSize)}</span>
                  {template.atsFriendly ? <span>ATS profile</span> : null}
                  <span>Fonts {template.licence}</span>
                </p>
              </div>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}

export default TemplateSwitch;
