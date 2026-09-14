import { TemplateProps } from './types';
import { ReactiveBase } from './ReactiveBase';

export function ReactiveClassic(props: TemplateProps) {
  return <ReactiveBase {...props} variant="classic" />;
}

export const reactiveClassicInfo = {
  id: 'reactive-classic',
  name: 'Classic Navy',
  description: 'Classic layout: centered navy header with uppercase section titles.',
  category: 'classic' as const,
  isAtsOptimized: true,
};
