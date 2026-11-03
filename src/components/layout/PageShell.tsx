import type { ReactNode } from "react";
import { PageBody, type PageBodyWidth } from "./PageBody";

interface PageShellProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  width?: PageBodyWidth;
  children: ReactNode;
}

/**
 * The shared authenticated-page frame. Header, toolbar and body all start on
 * the same 32px gutter, and the body is never centred: the width ladder caps
 * how far it can grow, it does not move its left edge.
 */
export function PageShell({
  title,
  description,
  actions,
  toolbar,
  width = "prose",
  children,
}: PageShellProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border bg-paper px-8 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title text-ink">{title}</h1>
          {description ? <p className="mt-1 text-sm text-ink-3">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {toolbar ? <div className="border-b border-border bg-paper px-8 py-3">{toolbar}</div> : null}
      <div className="flex-1 overflow-auto">
        <PageBody width={width} className="px-8 py-6">
          {children}
        </PageBody>
      </div>
    </div>
  );
}

export default PageShell;
