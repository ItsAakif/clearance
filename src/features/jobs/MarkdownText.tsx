// Dependency-free renderer for the normalized job-description markdown subset
// (ADR-020 / jd-md-normalization spec). Only these constructs become elements:
// `## ` / `### ` headings, `- ` bullets, `1. ` ordered items, `**bold**`,
// `` `code` ``, and `[text](url)` links. Everything else renders as literal
// text. React elements only: no `dangerouslySetInnerHTML`, no raw HTML
// injection. Only `http(s)` hrefs become anchors (with
// `target="_blank"` + `rel="noreferrer noopener"`); any other href renders
// as plain text, so `javascript:` / `data:` links can never execute.
import type { ReactElement, ReactNode } from 'react';

function isSafeHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

// Inline constructs without links, used for link text so anchors never nest.
function renderInlineNoLink(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+?)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const inner = match[1];
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`}>
          {inner ? renderInlineNoLink(inner, `${keyPrefix}-b${index}`) : inner}
        </strong>,
      );
    } else {
      nodes.push(<code key={`${keyPrefix}-c${index}`}>{match[2]}</code>);
    }
    last = match.index + match[0].length;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+?)`|\[([^\]]+?)\]\(([^)]+?)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const inner = match[1];
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`}>
          {inner ? renderInline(inner, `${keyPrefix}-b${index}`) : inner}
        </strong>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-c${index}`}>{match[2]}</code>);
    } else {
      const label = match[3];
      const href = match[4];
      if (isSafeHttpUrl(href)) {
        nodes.push(
          <a
            key={`${keyPrefix}-a${index}`}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInlineNoLink(label, `${keyPrefix}-a${index}`)}
          </a>,
        );
      } else {
        // Unsafe or unknown scheme: render the raw source as inert text.
        nodes.push(match[0]);
      }
    }
    last = match.index + match[0].length;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownText({ markdown }: { markdown: string }): ReactElement {
  const lines = markdown.split('\n');
  const blocks: ReactNode[] = [];
  let bulletGroup: string[] = [];
  let orderedGroup: string[] = [];
  let key = 0;

  const flushLists = () => {
    if (bulletGroup.length > 0) {
      const items = bulletGroup;
      bulletGroup = [];
      blocks.push(
        <ul key={`md-${key++}`} className="list-disc space-y-1 pl-5">
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `md-${key}-li${i}`)}</li>
          ))}
        </ul>,
      );
    }
    if (orderedGroup.length > 0) {
      const items = orderedGroup;
      orderedGroup = [];
      blocks.push(
        <ol key={`md-${key++}`} className="list-decimal space-y-1 pl-5">
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `md-${key}-li${i}`)}</li>
          ))}
        </ol>,
      );
    }
  };

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      flushLists();
      blocks.push(
        <h4 key={`md-${key++}`} className="text-xs font-semibold text-foreground">
          {renderInline(line.replace(/^###\s+/, ''), `md-${key}-h`)}
        </h4>,
      );
    } else if (/^##\s+/.test(line)) {
      flushLists();
      blocks.push(
        <h3 key={`md-${key++}`} className="text-sm font-semibold text-foreground">
          {renderInline(line.replace(/^##\s+/, ''), `md-${key}-h`)}
        </h3>,
      );
    } else if (/^-\s+/.test(line)) {
      if (orderedGroup.length > 0) flushLists();
      bulletGroup.push(line.replace(/^-\s+/, ''));
    } else if (/^\d+\.\s+/.test(line)) {
      if (bulletGroup.length > 0) flushLists();
      orderedGroup.push(line.replace(/^\d+\.\s+/, ''));
    } else if (line.trim() === '') {
      flushLists();
    } else {
      flushLists();
      // Unknown markdown stays literal text: never parsed as HTML, never dropped.
      blocks.push(
        <p key={`md-${key++}`} className="whitespace-pre-wrap break-words">
          {renderInline(line, `md-${key}-p`)}
        </p>,
      );
    }
  }
  flushLists();

  if (blocks.length === 0) return <></>;
  return <div className="space-y-2 text-sm text-ink-2">{blocks}</div>;
}
