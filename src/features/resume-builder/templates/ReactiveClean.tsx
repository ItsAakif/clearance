import { TemplateProps } from './types';
import { ReactiveBase } from './ReactiveBase';

export function ReactiveClean(props: TemplateProps) {
  return <ReactiveBase {...props} variant="clean" />;
}

export const reactiveCleanInfo = {
  id: 'reactive-clean',
  name: 'Clean Minimal',
  description: 'Clean layout: generous whitespace, capitalized headings, minimal divider.',
  category: 'minimal' as const,
  isAtsOptimized: true,
};
