// The reference list under one candidate (T1100, 06 sec. E.5's anti-copying rule).
//
// INSPIRATION, WITH ITS LICENCE AND ITS ACTIVITY. A reference is a repository somebody else
// wrote, and this component is explicit about that: it names the kind, the licence, and when the
// repository was last touched, under a heading that says the project has to be the user's own.
// There is no "copy", no "template" and no download of text, because the engine's rule is that a
// candidate may not be a reimplementation - the server measures that and refuses it.
//
// THE FOUR FACTS ARE FACTS, NOT A JUDGEMENT. Licence, last push, stars and releases are how a
// reader checks the reference afterwards. They are never combined into a figure about the
// repository or about the candidate.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen } from "lucide-react";
import { activityFacts, referenceNote } from "./projectPresentation";
import type { ProjectReference } from "@/services/api/projectDiscovery";

interface ReferenceListProps {
  references: ProjectReference[];
  className?: string;
}

export function ReferenceList({ references, className }: ReferenceListProps) {
  return (
    <Card className={className ?? ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-ink-3" aria-hidden="true" />
          Inspiration
        </CardTitle>
        <CardDescription>
          {references.length === 0
            ? "No public repository was consulted for this candidate."
            : referenceNote()}
        </CardDescription>
      </CardHeader>
      {references.length > 0 ? (
        <CardContent>
          <ul className="space-y-3">
            {references.map((reference) => (
              <li key={reference.url} className="border-b border-rule py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <a
                    className="text-sm font-medium text-ink underline underline-offset-2"
                    href={reference.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {reference.title}
                  </a>
                  <Badge variant="outline" className="text-xs2">
                    {reference.kind.replace(/_/g, " ")}
                  </Badge>
                </div>
                <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs2 text-ink-3">
                  {activityFacts(reference).map((fact) => (
                    <div key={fact.label} className="flex gap-1">
                      <dt>{fact.label}:</dt>
                      <dd className="text-ink">{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

export default ReferenceList;