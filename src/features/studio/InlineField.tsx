// InlineField.tsx - the inline rich-text primitive (T1050; ADR-037 item 2).
//
// A `contentEditable` whose MODEL IS AN EXPLICIT RUN LIST. The DOM is a rendering of
// `{format:"inline-v1", runs:[{text, marks}]}` and is read back into that shape on every
// input; it is never the value. Everything about the conversion lives in `inlineDom.ts`,
// which is a pure module this repo's node-only runner can actually test.
//
// THREE PROPERTIES THIS COMPONENT IS RESPONSIBLE FOR:
//
//   1. NO NEW DEPENDENCY, and no `document.execCommand`. The legacy builder's rich text was
//      produced by `execCommand` and then discarded (ADR-037, Context); nothing here calls
//      it, and there is no ProseMirror/Tiptap document in the tree. The primitive is this
//      file because the model is three marks and one paragraph.
//   2. A PASTE IS PLAIN TEXT. The browser is never allowed to insert markup this value
//      cannot describe, so a paste cannot smuggle in a formatting vocabulary.
//   3. IT IS A SINGLE PARAGRAPH. Enter is refused. A resume field is one line of prose, and a
//      multi-paragraph value has no representation in the JSON Resume member it edits (a
//      `string`), so accepting one would lose it on the next round trip.
//
// ACCESSIBILITY. The editing surface is `role="textbox"` with `aria-multiline` false and an
// `aria-label`, so a screen reader announces it as a single-line field with a name rather than
// as an unlabelled region. The three marks are REAL BUTTONS with `aria-pressed`, reachable by
// Tab and operable with Enter/Space - and each also has a `Ctrl`/`Cmd` chord, because a
// formatting action a keyboard user cannot reach is not a formatting action. The mark state is
// text on the button, not a colour.

import { useCallback, useEffect, useRef } from 'react';
import { Bold, Italic, Link as LinkIcon } from 'lucide-react';
import {
  applyMarkToRange,
  inlineToPlainText,
  normalizeInlineValue,
  type InlineMark,
  type InlineRun,
  type InlineValue,
} from './blockModel';
import {
  MARKS_ATTRIBUTE,
  domChildrenFromRuns,
  domOffset,
  inlineValueFromNodes,
  markShortcut,
  pastedText,
  textLength,
  type DomLike,
} from './inlineDom';

const MARKS: ReadonlyArray<{ mark: InlineMark; label: string; chord: string; Icon: typeof Bold }> = [
  { mark: 'bold', label: 'Bold', chord: 'Ctrl+B', Icon: Bold },
  { mark: 'italic', label: 'Italic', chord: 'Ctrl+I', Icon: Italic },
  { mark: 'link', label: 'Link', chord: 'Ctrl+K', Icon: LinkIcon },
];

/** Where each run starts and ends, in characters. Derived per call; never cached in state. */
function spans(value: InlineValue): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let position = 0;
  for (const run of value.runs) {
    out.push({ from: position, to: position + run.text.length });
    position += run.text.length;
  }
  return out;
}

/** The run the caret sits in, or `null` when it sits past the last character. */
function spanAt(value: InlineValue, offset: number): { from: number; to: number } | null {
  const found = spans(value).find((span) => offset >= span.from && offset < span.to);
  return found ?? null;
}

/** Whether every run the range covers carries the mark. */
function rangeCarries(value: InlineValue, from: number, to: number, mark: InlineMark): boolean {
  if (to <= from) return false;
  const covered = spans(value).filter((span) => span.to > from && span.from < to);
  if (covered.length === 0) return false;
  return covered.every((span) => {
    const index = spans(value).indexOf(span);
    return (value.runs[index]?.marks ?? []).includes(mark);
  });
}

/** Replace `[from, to)` of a run list with one unmarked run of `text`. */
function spliceRuns(runs: readonly InlineRun[], from: number, to: number, text: string): InlineRun[] {
  const out: InlineRun[] = [];
  const inserted: InlineRun[] = text.length > 0 ? [{ text }] : [];
  let position = 0;
  for (const run of runs) {
    const start = position;
    const end = position + run.text.length;
    position = end;
    if (end <= from || start >= to) {
      out.push(run);
      continue;
    }
    // Everything before the replaced range is emitted, then the insertion, then the rest -
    // so the order is correct for a caret insertion as well as a selection replacement.
    const head = run.text.slice(0, Math.max(0, from - start));
    if (head.length > 0) out.push(head === run.text ? run : { ...run, text: head });
    if (inserted.length > 0) {
      out.push(...inserted.splice(0, inserted.length));
    }
    const tail = run.text.slice(Math.max(0, to - start));
    if (tail.length > 0) out.push(tail === run.text ? run : { ...run, text: tail });
  }
  // A replacement entirely outside any run (an empty value): append at the end, which is where
  // the caret is when there is nothing before it.
  if (inserted.length > 0) out.push(...inserted);
  return out;
}

export interface InlineFieldProps {
  id: string;
  /** The accessible name of the editing surface. Also the visible label. */
  label: string;
  value: InlineValue;
  onChange: (value: InlineValue) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Extra context rendered under the field (e.g. which claim backs it). */
  description?: string;
}

/** The current selection as character offsets, or `null` when there is none in this field. */
function selectionOffsets(element: HTMLElement): { from: number; to: number } | null {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const root = element as unknown as DomLike;
  const from = domOffset(root, range.startContainer as unknown as DomLike, range.startOffset);
  const to = domOffset(root, range.endContainer as unknown as DomLike, range.endOffset);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

/** Put the caret at a character offset, without relying on a deprecated command. */
function placeCaret(element: HTMLElement, offset: number): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
}

/**
 * Write the run list into the DOM. Runs become spans carrying `data-marks`, so reading the DOM
 * back (`inlineDom.runsFromNodes`) recovers exactly the runs written here.
 */
function renderRuns(element: HTMLElement, value: InlineValue): void {
  while (element.firstChild) element.removeChild(element.firstChild);
  const children = domChildrenFromRuns(value.runs);
  if (children.length === 0) {
    // A zero-length text node keeps the field focusable and lets a caret exist inside an
    // empty value, which is the state a user first meets.
    element.appendChild(document.createTextNode(''));
    return;
  }
  for (const child of children) {
    if (child.marks.length === 0) {
      element.appendChild(document.createTextNode(child.text));
      continue;
    }
    const span = document.createElement('span');
    span.setAttribute(MARKS_ATTRIBUTE, child.marks.join(' '));
    span.textContent = child.text;
    element.appendChild(span);
  }
}

export function InlineField({ id, label, value, onChange, placeholder, disabled, description }: InlineFieldProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  // The text the DOM currently shows. A prop change that is not a consequence of this field's
  // own input (an exclude/include elsewhere rewrote the text) has to be re-rendered.
  const renderedRef = useRef<string | null>(null);

  const commit = useCallback(
    (next: InlineValue) => {
      const normalized = normalizeInlineValue(next);
      renderedRef.current = inlineToPlainText(normalized);
      onChange(normalized);
    },
    [onChange],
  );

  const readDom = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    commit(inlineValueFromNodes(Array.from(element.childNodes) as unknown as DomLike[]));
  }, [commit]);

  // Re-render when the value changed from OUTSIDE this field.
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const plain = inlineToPlainText(value);
    if (renderedRef.current === plain) return;
    const hadFocus = typeof document !== 'undefined' && document.activeElement === element;
    renderedRef.current = plain;
    renderRuns(element, value);
    if (hadFocus) placeCaret(element, plain.length);
  }, [value]);

  const toggle = useCallback(
    (mark: InlineMark) => {
      const element = elementRef.current;
      if (!element || disabled) return;
      const selection = selectionOffsets(element);
      const plain = inlineToPlainText(value);
      const target =
        selection && selection.to > selection.from
          ? { from: selection.from, to: selection.to }
          : (spanAt(value, selection ? selection.from : plain.length) ?? {
              from: plain.length,
              to: plain.length,
            });
      // A collapsed caret at the very end of an empty (or fully unmarked-tail) value has no
      // characters to mark, so the whole value is marked instead: a button that visibly does
      // nothing when there IS text is a dead control.
      const range = target.to > target.from ? target : { from: 0, to: plain.length };
      const next = applyMarkToRange(value, range.from, range.to, mark);
      commit(next);
      renderRuns(element, next);
      placeCaret(element, range.to);
    },
    [commit, disabled, value],
  );

  const isMarkActive = useCallback(
    (mark: InlineMark) => {
      const element = elementRef.current;
      const selection = element ? selectionOffsets(element) : null;
      const plain = inlineToPlainText(value);
      if (!selection || selection.to === selection.from) {
        const span = spanAt(value, selection ? selection.from : 0);
        if (!span) return false;
        const index = spans(value).indexOf(span);
        return (value.runs[index]?.marks ?? []).includes(mark);
      }
      if (!rangeCarries(value, selection.from, selection.to, mark)) return false;
      return plain.length > 0;
    },
    [value],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter') {
        // One paragraph: the value has no representation for a newline in a JSON Resume
        // `string` member, so accepting one would lose it.
        event.preventDefault();
        return;
      }
      const mark = markShortcut(event);
      if (!mark) return;
      event.preventDefault();
      toggle(mark);
    },
    [toggle],
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const element = elementRef.current;
      if (!element) return;
      const text = pastedText(event.nativeEvent);
      const selection = selectionOffsets(element);
      const end = selection ? selection.to : textLength(element as unknown as DomLike);
      const from = selection ? selection.from : end;
      const next = normalizeInlineValue({ format: 'inline-v1', runs: spliceRuns(value.runs, from, end, text) });
      if (text.length === 0 && next.runs.length === 0) return;
      commit(next);
      renderRuns(element, next);
      placeCaret(element, from + text.length);
    },
    [commit, value],
  );

  const describedBy = description ? `${id}-description` : undefined;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${id}-label`} className="text-xs2 font-medium text-ink">
          {label}
        </span>
        <div className="flex items-center gap-1" role="group" aria-label={`Formatting for ${label}`}>
          {MARKS.map(({ mark, label: markLabel, chord, Icon }) => (
            <button
              key={mark}
              type="button"
              disabled={disabled}
              aria-pressed={isMarkActive(mark)}
              aria-label={`${markLabel} (${chord})`}
              title={`${markLabel} (${chord})`}
              onClick={() => toggle(mark)}
              className="inline-flex h-6 items-center gap-1 rounded-control border border-rule px-1.5 text-xs2 text-ink-3 hover:bg-muted disabled:opacity-50 aria-pressed:border-primary aria-pressed:text-ink"
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
              {markLabel}
            </button>
          ))}
        </div>
      </div>
      <div
        id={id}
        ref={elementRef}
        role="textbox"
        aria-multiline="false"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={readDom}
        onBlur={readDom}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        className="min-h-[2.25rem] w-full rounded-control border border-rule bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring empty:before:text-ink-3 empty:before:content-[attr(data-placeholder)] aria-disabled:opacity-60"
      />
      {description ? (
        <p id={describedBy} className="text-xs2 text-ink-3">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export default InlineField;