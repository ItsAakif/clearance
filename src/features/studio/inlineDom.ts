// inlineDom.ts - the DOM half of the inline rich-text primitive (T1050; ADR-037 item 2).
//
// WHY THIS IS A SEPARATE `.ts` MODULE. `InlineField.tsx` is a component, and this repo's
// frontend runner is node-only with no jsdom and no component tests (ADR-031 decision 3), so
// a conversion function that could only be exercised through a component could not be
// tested at all. Everything here is therefore a PURE function over a STRUCTURAL description
// of a DOM subtree - `nodeType`, `textContent`, `childNodes`, `getAttribute` - which a real
// `Node` satisfies structurally and a plain object literal in a test also satisfies. The
// component adapts the browser's nodes into these shapes; the test builds the shapes by hand.
//
// WHAT THE PRIMITIVE IS. A `contentEditable` whose model is an EXPLICIT RUN LIST, never HTML.
// Three marks are supported (`bold`, `italic`, `link`); the mark a run carries travels in a
// `data-marks` attribute on the span that represents it, and a run's marks are read back from
// that attribute rather than inferred from computed styles. That is what makes the round trip
// exact: there is no "what did the browser decide the formatting was" step for a value to
// disagree with.
//
// IT IS NOT THE DOCUMENT MODEL, and it is not a general rich text editor either: the value it
// produces is `{format:"inline-v1", runs:[{text, marks}]}` (in `blockModel.ts`), which the
// Studio flattens to a plain string because the JSON Resume members it edits are
// `type: 'string'`. A run with an unknown mark in the DOM is DROPPED rather than carried
// through - the alternative is a value the schema does not describe, saved into a document.

import { INLINE_MARKS, type InlineMark, type InlineRun, type InlineValue } from "./blockModel";

/** `Node.ELEMENT_NODE` / `Node.TEXT_NODE`, restated so no DOM lib is needed here. */
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

/** The attribute a marked span carries its marks in. Named, so the two halves cannot drift. */
export const MARKS_ATTRIBUTE = 'data-marks';

/** The subset of a DOM node this module reads. A real `Node` satisfies it structurally. */
export interface DomLike {
  nodeType: number;
  textContent?: string | null;
  childNodes?: ArrayLike<DomLike>;
  getAttribute?: (name: string) => string | null;
}

function isElement(node: DomLike): boolean {
  return node.nodeType === ELEMENT_NODE;
}

/** The marks a span declares, in canonical (sorted, de-duplicated) order. */
export function marksFromAttribute(value: string | null | undefined): InlineMark[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const marks = value
    .split(' ')
    .filter((entry): entry is InlineMark => (INLINE_MARKS as readonly string[]).includes(entry));
  return [...new Set(marks)].sort();
}

/**
 * Read a subtree into runs, in document order.
 *
 * `BR` becomes a newline inside the current run rather than a run boundary: a soft break in a
 * bullet is text, and dropping it would silently lose a character the user typed. Element
 * boundaries with identical marks are merged by `normalizeInlineValue` upstream, so a browser
 * that splits a styled span in three costs nothing.
 */
export function runsFromNodes(nodes: readonly DomLike[]): InlineRun[] {
  const runs: InlineRun[] = [];
  const walk = (node: DomLike, marks: readonly InlineMark[]): void => {
    if (node.nodeType === TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.length === 0) return;
      runs.push(marks.length === 0 ? { text } : { text, marks: [...marks] });
      return;
    }
    if (!isElement(node)) return;
    const ownMarks = marksFromAttribute(node.getAttribute?.(MARKS_ATTRIBUTE) ?? null);
    const merged = [...new Set([...marks, ...ownMarks])].sort();
    const children = node.childNodes ? Array.from(node.childNodes) : [];
    if (children.length === 0) {
      // An empty element still means "a run the user is typing into", and dropping it would
      // make an emptied styled run look like a deleted one on the next read.
      return;
    }
    for (const child of children) walk(child, merged);
  };
  for (const node of nodes) walk(node, []);
  return runs;
}

/** The inline value a subtree currently represents. */
export function inlineValueFromNodes(nodes: readonly DomLike[]): InlineValue {
  return { format: 'inline-v1', runs: runsFromNodes(nodes) };
}

/** The children a run list renders to: one span per marked run, a bare text node otherwise. */
export function domChildrenFromRuns(runs: readonly InlineRun[]): Array<{ text: string; marks: InlineMark[] }> {
  return runs
    .filter((run) => run.text.length > 0)
    .map((run) => ({ text: run.text, marks: [...(run.marks ?? [])].sort() }));
}

/**
 * The character offset of a DOM position, counted across the whole subtree.
 *
 * Needed because a selection is a (node, offset) PAIR and the run list is indexed by
 * characters. Walking the subtree in document order and summing the text of every node
 * before the container gives the offset; a container that is not inside `root` yields the
 * total length, i.e. "the end", rather than throwing - a selection the primitive cannot map
 * should place the mark at the end, not break the editor.
 */
export function domOffset(root: DomLike, container: DomLike, containerOffset: number): number {
  let total = 0;
  let found = false;
  const walk = (node: DomLike): void => {
    if (found) return;
    if (node === container) {
      total += Math.max(0, Math.min(containerOffset, (node.textContent ?? '').length));
      found = true;
      return;
    }
    if (node.nodeType === TEXT_NODE) {
      total += (node.textContent ?? '').length;
      return;
    }
    const children = node.childNodes ? Array.from(node.childNodes) : [];
    for (const child of children) {
      walk(child);
      if (found) return;
    }
  };
  walk(root);
  return found ? total : textLength(root);
}

/** The number of characters a subtree holds. */
export function textLength(root: DomLike): number {
  if (root.nodeType === TEXT_NODE) return (root.textContent ?? '').length;
  const children = root.childNodes ? Array.from(root.childNodes) : [];
  return children.reduce((sum, child) => sum + textLength(child), 0);
}

/**
 * The text a paste should insert, with every formatting hint stripped.
 *
 * PASTE IS PLAIN TEXT BY CONSTRUCTION. A pasted fragment carries markup this primitive does
 * not model (inserting a browser "insert HTML" command is exactly how the legacy builder lost
 * its formatting, per ADR-037's Context), so `InlineField` intercepts the paste and inserts
 * `text/plain`. The alternative - letting the browser insert HTML and reading the marks back
 * out of it - would put a second, browser-defined formatting vocabulary into the value.
 */
export function pastedText(event: { clipboardData?: DataTransfer | null }): string {
  const raw = event.clipboardData?.getData('text/plain');
  return typeof raw === 'string' ? raw : '';
}

/** `Ctrl`/`Cmd` + key, the two chords the toolbar offers as shortcuts. */
export function markShortcut(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): InlineMark | null {
  if (!event.ctrlKey && !event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'b') return 'bold';
  if (key === 'i') return 'italic';
  if (key === 'k') return 'link';
  return null;
}