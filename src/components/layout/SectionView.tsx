import type { ReactNode } from "react";

interface SectionViewProps {
  title: ReactNode;
  description?: ReactNode;
}

/**
 * The view heading inside a merged section.
 *
 * The section's own `PageShell` h1 names the SECTION (Profile, Resumes, Match,
 * Interview); the tab bar says which view is open; this heading names that view in
 * the content, with the context line that used to sit under the old page title.
 * Keeping it in one component is what stops the four sections drifting apart.
 */
export function SectionView({ title, description }: SectionViewProps) {
  return (
    <div className="mb-6">
      <h2 className="section-title">{title}</h2>
      {description ? <p className="mt-1 text-sm text-ink-3">{description}</p> : null}
    </div>
  );
}

export default SectionView;
