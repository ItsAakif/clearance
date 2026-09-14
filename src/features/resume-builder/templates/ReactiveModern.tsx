import { TemplateProps } from './types';
import { ReactiveBase } from './ReactiveBase';

export function ReactiveModern(props: TemplateProps) {
  return <ReactiveBase {...props} variant="modern" />;
}

export const reactiveModernInfo = {
  id: 'reactive-modern',
  name: 'Modern Teal',
  description: 'Modern layout: left-aligned teal accent bar with clean section headings.',
  category: 'modern' as const,
  isAtsOptimized: true,
};
