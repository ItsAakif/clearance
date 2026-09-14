import { TemplateProps } from './types';
import { ReactiveBase } from './ReactiveBase';

export function ReactiveEngineering(props: TemplateProps) {
  return <ReactiveBase {...props} variant="engineering" />;
}

export const reactiveEngineeringInfo = {
  id: 'reactive-engineering',
  name: 'Technical Compact',
  description: 'Engineering layout: compact, monospace bullets, blue accent for technical roles.',
  category: 'professional' as const,
  isAtsOptimized: true,
};
