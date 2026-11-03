// Unit tests for the inline rich-text primitive's value and DOM conversion (T1050).
//
// Runner: vitest, node environment (ADR-031 decision 3 - no jsdom, no component tests). The
// DOM half lives in `inlineDom.ts` precisely so it can be tested here with plain objects that
// satisfy its structural `DomLike` shape, rather than through a component this runner cannot
// render.
//
// WHAT IS PINNED:
//   1. THE SERIALISATION ROUND TRIP. `plainText -> runs -> plainText` is lossless, and
//      normalising merges runs that read identically - two documents that READ the same must
//      produce the same bytes, or `jsonHash` stops being an identity.
//   2. THE DOM -> RUNS CONVERSION IS EXPLICIT. Marks travel in `data-marks`; an unknown mark is
//      dropped rather than carried into a value the schema does not describe.
//   3. NO `document.execCommand`. The legacy builder produced its formatting with a deprecated
//      command and then discarded it (ADR-037, Context); the grep below is the guard, because
//      the failure it prevents is invisible in a unit test.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMarkToRange,
  canonicalJsonString,
  inlineFromPlainText,
  inlineToPlainText,
  normalizeInlineValue,
  plainTextToInline,
  runOffsets,
  splitRunsAt,
  toggleRunMark,
  type InlineRun,
  type InlineValue,
} from './blockModel';
import {
  MARKS_ATTRIBUTE,
  domChildrenFromRuns,
  domOffset,
  inlineValueFromNodes,
  markShortcut,
  marksFromAttribute,
  pastedText,
  runsFromNodes,
  textLength,
  type DomLike,
} from './inlineDom';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures: a subtree described structurally, exactly as the browser would
// ---------------------------------------------------------------------------

/** A text node. */
function textNode(value: string): DomLike {
  return { nodeType: 3, textContent: value, childNodes: [] };
}

/** An element node with an optional `data-marks` attribute. */
function spanNode(marks: readonly string[] | null, children: readonly DomLike[]): DomLike {
  return {
    nodeType: 1,
    textContent: children.map((child) => child.textContent ?? '').join(''),
    childNodes: children as unknown as ArrayLike<DomLike>,
    getAttribute: (name: string) => (name === MARKS_ATTRIBUTE && marks ? marks.join(' ') : null),
  };
}

// ---------------------------------------------------------------------------
// 1. The value
// ---------------------------------------------------------------------------

describe('the inline value is {format:"inline-v1", runs:[...]} and round-trips', () => {
  it('names the shipped format and version', () => {
    const value = plainTextToInline('hello');
    assert.equal(value.format, 'inline-v1');
    assert.equal(typeof value.runs, 'object');
  });

  it('round-trips plain text losslessly, including the empty string', () => {
    for (const text of ['', ' ', 'Cut CI build time by 40%', 'trailing   ', 'a\nb']) {
      assert.equal(inlineToPlainText(plainTextToInline(text)), text, JSON.stringify(text));
      assert.equal(inlineToPlainText(inlineFromPlainText(text)), text, JSON.stringify(text));
    }
  });

  it('keeps the marks and flattens to the exact text', () => {
    const value: InlineValue = {
      format: 'inline-v1',
      runs: [
        { text: 'Cut ' },
        { text: 'CI', marks: ['bold'] },
        { text: ' build time by ' },
        { text: '40%', marks: ['italic'] },
      ],
    };
    assert.equal(inlineToPlainText(value), 'Cut CI build time by 40%');
    // ...and the document member is that string, because the JSON Resume members the Studio
    // edits are `type: 'string'`. An object there would fail schema validation.
    assert.equal(typeof inlineToPlainText(value), 'string');
  });

  it('merges adjacent runs with the same marks and drops empty runs', () => {
    assert.deepEqual(
      normalizeInlineValue({
        format: 'inline-v1',
        runs: [
          { text: 'a', marks: ['bold'] },
          { text: '', marks: ['bold'] },
          { text: 'b', marks: ['bold', 'bold'] },
          { text: 'c' },
          { text: '' },
        ],
      }).runs,
      [{ text: 'ab', marks: ['bold'] }, { text: 'c' }],
    );
  });

  it('normalises mark order and de-duplicates, so a hash cannot depend on toggle order', () => {
    const a = normalizeInlineValue({ format: 'inline-v1', runs: [{ text: 'x', marks: ['link', 'bold'] }] });
    const b = normalizeInlineValue({ format: 'inline-v1', runs: [{ text: 'x', marks: ['bold', 'link', 'bold'] }] });
    assert.deepEqual(a.runs[0].marks, ['bold', 'link']);
    assert.equal(canonicalJsonString(a), canonicalJsonString(b));
  });

  it('DROPS a mark it does not model rather than carrying it into the value', () => {
    // The alternative - persisting `['bold','blink']` - would put a value the inline schema
    // does not describe into a document.
    const normalized = normalizeInlineValue({
      format: 'inline-v1',
      runs: [{ text: 'x', marks: ['bold', 'blink' as never] }],
    });
    assert.deepEqual(normalized.runs[0].marks, ['bold']);
  });

  it('omits `marks` entirely for unmarked text rather than writing an empty array', () => {
    const normalized = normalizeInlineValue({ format: 'inline-v1', runs: [{ text: 'x', marks: [] }] });
    assert.equal('marks' in normalized.runs[0], false);
  });
});

// ---------------------------------------------------------------------------
// 2. Marks
// ---------------------------------------------------------------------------

describe('toggling a mark is symmetric and idempotent in the value', () => {
  it('adds then removes it, returning the original bytes', () => {
    const base: InlineRun = { text: 'CI' };
    const bolded = toggleRunMark(base, 'bold');
    assert.deepEqual(bolded, { text: 'CI', marks: ['bold'] });
    assert.deepEqual(toggleRunMark(bolded, 'bold'), base);
  });

  it('applies a mark across a range, splitting the run it crosses', () => {
    const value: InlineValue = { format: 'inline-v1', runs: [{ text: 'Cut CI time' }] };
    const bolded = normalizeInlineValue(applyMarkToRange(value, 4, 6, 'bold'));
    assert.deepEqual(bolded.runs, [{ text: 'Cut ' }, { text: 'CI', marks: ['bold'] }, { text: ' time' }]);
    // The TEXT is unchanged: a mark never rewrites words.
    assert.equal(inlineToPlainText(bolded), inlineToPlainText(value));
  });

  it('is a NO-OP for an empty or inverted range', () => {
    const value: InlineValue = { format: 'inline-v1', runs: [{ text: 'abc' }] };
    assert.equal(canonicalJsonString(applyMarkToRange(value, 2, 2, 'bold')), canonicalJsonString(value));
    assert.equal(canonicalJsonString(applyMarkToRange(value, 3, 1, 'bold')), canonicalJsonString(value));
  });

  it('splits at an offset so a caret can be represented', () => {
    const value: InlineValue = {
      format: 'inline-v1',
      runs: [{ text: 'abcd' }, { text: 'ef', marks: ['bold'] }],
    };
    const split = splitRunsAt(value, 2);
    assert.deepEqual(split, [{ text: 'ab' }, { text: 'cd' }, { text: 'ef', marks: ['bold'] }]);
    // And the offsets of the runs are what a caret selection is expressed in.
    assert.deepEqual(runOffsets(split), [
      { index: 0, start: 0, end: 2 },
      { index: 1, start: 2, end: 4 },
      { index: 2, start: 4, end: 6 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. The DOM half
// ---------------------------------------------------------------------------

describe('the DOM is read back into explicit runs, not the other way round', () => {
  it('reads plain text as one unmarked run', () => {
    assert.deepEqual(runsFromNodes([textNode('Cut CI time')]), [{ text: 'Cut CI time' }]);
    assert.deepEqual(inlineValueFromNodes([textNode('x')]), {
      format: 'inline-v1',
      runs: [{ text: 'x' }],
    });
  });

  it('reads marks from `data-marks` and nothing else', () => {
    const nodes = [
      textNode('Cut '),
      spanNode(['bold'], [textNode('CI')]),
      textNode(' time'),
    ];
    assert.deepEqual(runsFromNodes(nodes), [
      { text: 'Cut ' },
      { text: 'CI', marks: ['bold'] },
      { text: ' time' },
    ]);
  });

  it('UNIONs nested marks, so a nested span does not lose the outer one', () => {
    const nodes = [spanNode(['bold'], [spanNode(['italic'], [textNode('CI')])])];
    assert.deepEqual(runsFromNodes(nodes), [{ text: 'CI', marks: ['bold', 'italic'] }]);
  });

  it('drops an unknown mark rather than persisting it', () => {
    assert.deepEqual(marksFromAttribute('bold blink'), ['bold']);
    assert.deepEqual(marksFromAttribute(null), []);
    assert.deepEqual(marksFromAttribute(''), []);
  });

  it('ignores an empty element: no run, no phantom text', () => {
    assert.deepEqual(runsFromNodes([spanNode(['bold'], [])]), []);
  });

  it('renders back to the same shape it reads - the round trip through the DOM', () => {
    const value: InlineValue = {
      format: 'inline-v1',
      runs: [
        { text: 'Cut ' },
        { text: 'CI', marks: ['bold'] },
        { text: ' build', marks: ['italic', 'bold'] },
        { text: ' time' },
      ],
    };
    const children = domChildrenFromRuns(value.runs);
    const nodes = children.map((child) =>
      child.marks.length === 0 ? textNode(child.text) : spanNode(child.marks, [textNode(child.text)]),
    );
    assert.deepEqual(runsFromNodes(nodes), normalizeInlineValue(value).runs);
    assert.equal(inlineToPlainText(inlineValueFromNodes(nodes)), inlineToPlainText(value));
  });

  it('omits an empty run from the DOM children, so an empty value renders nothing', () => {
    assert.deepEqual(domChildrenFromRuns([{ text: '' }]), []);
  });

  it('maps a DOM selection to character offsets, and a foreign container to the end', () => {
    const root = spanNode(null, [textNode('Cut '), spanNode(['bold'], [textNode('CI')])]);
    const inner = (root.childNodes as unknown as DomLike[])[1];
    const innerText = (inner.childNodes as unknown as DomLike[])[0];
    // A caret inside the bold run, one character in.
    assert.equal(domOffset(root, innerText, 1), 5);
    assert.equal(domOffset(root, (root.childNodes as unknown as DomLike[])[0], 2), 2);
    // A selection the primitive cannot map places the mark at the end rather than throwing.
    assert.equal(domOffset(root, textNode('elsewhere'), 0), textLength(root));
    assert.equal(textLength(root), 6);
  });
});

// ---------------------------------------------------------------------------
// 4. Pasting and shortcuts
// ---------------------------------------------------------------------------

describe('a paste is plain text by construction', () => {
  it('reads `text/plain` and ignores every other clipboard flavour', () => {
    const asked: string[] = [];
    const clipboard = {
      getData: (flavour: string) => {
        asked.push(flavour);
        return flavour === 'text/plain' ? 'pasted words' : '<b>markup</b>';
      },
    } as unknown as DataTransfer;
    assert.equal(pastedText({ clipboardData: clipboard }), 'pasted words');
    assert.deepEqual(asked, ['text/plain']);
  });

  it('yields an empty string when there is no clipboard data', () => {
    assert.equal(pastedText({ clipboardData: null }), '');
    assert.equal(pastedText({}), '');
  });
});

describe('the three marks have keyboard chords', () => {
  it('maps Ctrl/Cmd + B, I and K, and nothing else', () => {
    assert.equal(markShortcut({ key: 'b', ctrlKey: true }), 'bold');
    assert.equal(markShortcut({ key: 'I', metaKey: true }), 'italic');
    assert.equal(markShortcut({ key: 'k', ctrlKey: true }), 'link');
    // No modifier is not a mark action: a bare `b` must type a "b".
    assert.equal(markShortcut({ key: 'b' }), null);
    assert.equal(markShortcut({ key: 'z', ctrlKey: true }), null);
  });
});

// ---------------------------------------------------------------------------
// 5. No deprecated editor API, and no new dependency
// ---------------------------------------------------------------------------

describe('the primitive adds no dependency and does not use execCommand', () => {
  const primitiveSources = ['InlineField.tsx', 'inlineDom.ts', 'blockModel.ts'].map((name) =>
    readFileSync(path.join(HERE, name), 'utf8'),
  );

  it('never CALLS the deprecated execCommand API the legacy builder lost its formatting to', () => {
    // The pattern is a member CALL, not the word: the prose in these files explains why the
    // deprecated command is avoided, and a grep for the bare word would forbid explaining it.
    for (const source of primitiveSources) {
      assert.equal(/\.execCommand\s*\(/.test(source), false);
    }
  });

  it('imports nothing outside the repo and the React runtime', () => {
    // A rich-text dependency is the thing ADR-037 item 2 exists to avoid; a stray import here
    // is how one would creep in without a decision.
    const imports = primitiveSources.join('\n').match(/from\s+"([^"]+)"/g) ?? [];
    for (const statement of imports) {
      const specifier = statement.replace(/from\s+"/, '').replace(/"/, '');
      const allowed =
        specifier.startsWith('./') ||
        specifier.startsWith('@/') ||
        specifier === 'react';
      assert.ok(allowed, `unexpected import: ${specifier}`);
    }
  });

  it('refuses Enter, so a value can never contain a paragraph break', () => {
    // The JSON Resume member it edits is a `string`; a newline in a bullet is representable,
    // but a paragraph is not, and silently flattening one would lose the user's text.
    const source = primitiveSources[0];
    assert.match(source, /event\.key === 'Enter'/);
    assert.match(source, /preventDefault\(\)/);
  });
});