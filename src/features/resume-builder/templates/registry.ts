import { TemplateRegistryEntry, TemplateInfo } from './types';
import { ProfessionalStandard, professionalStandardInfo } from './ProfessionalStandard';
import { ModernMinimal, modernMinimalInfo } from './ModernMinimal';
import { ClassicElegant, classicElegantInfo } from './ClassicElegant';
import { TwoColumnExecutive, twoColumnExecutiveInfo } from './TwoColumnExecutive';
import { ElegantSidebar, elegantSidebarInfo } from './ElegantSidebar';
import { PhotoHeader, photoHeaderInfo } from './PhotoHeader';
import { CreativeDesigner, creativeDesignerInfo } from './CreativeDesigner';
import { Timeline, timelineInfo } from './Timeline';
import { Compact, compactInfo } from './Compact';
import { SimpleATS, simpleATSInfo } from './SimpleATS';
import { MinimalistDesigner, minimalistDesignerInfo } from './MinimalistDesigner';
import { SidebarPhotoLeft, sidebarPhotoLeftInfo } from './SidebarPhotoLeft';
import { SidebarPhotoRight, sidebarPhotoRightInfo } from './SidebarPhotoRight';
import { BoldHeader, boldHeaderInfo } from './BoldHeader';
import { HeaderPhotoCentered, headerPhotoCenteredInfo } from './HeaderPhotoCentered';
import { SplitEqual, splitEqualInfo } from './SplitEqual';
import { ModernCards, modernCardsInfo } from './ModernCards';
import { ClassicSidebar, classicSidebarInfo } from './ClassicSidebar';
import { ExecutiveClassic, executiveClassicInfo } from './ExecutiveClassic';
import { TechModern, techModernInfo } from './TechModern';
import { AccentLine, accentLineInfo } from './AccentLine';
import { PortfolioDesigner, portfolioDesignerInfo } from './PortfolioDesigner';
import { ReactiveClassic, reactiveClassicInfo } from './ReactiveClassic';
import { ReactiveModern, reactiveModernInfo } from './ReactiveModern';
import { ReactiveClean, reactiveCleanInfo } from './ReactiveClean';
import { ReactiveEngineering, reactiveEngineeringInfo } from './ReactiveEngineering';

const registry: Map<string, TemplateRegistryEntry> = new Map();

function registerTemplate(info: TemplateInfo, Component: TemplateRegistryEntry['Component']) {
  registry.set(info.id, { info, Component });
}

registerTemplate(professionalStandardInfo, ProfessionalStandard);
registerTemplate(modernMinimalInfo, ModernMinimal);
registerTemplate(classicElegantInfo, ClassicElegant);
registerTemplate(twoColumnExecutiveInfo, TwoColumnExecutive);
registerTemplate(elegantSidebarInfo, ElegantSidebar);
registerTemplate(photoHeaderInfo, PhotoHeader);
registerTemplate(creativeDesignerInfo, CreativeDesigner);
registerTemplate(timelineInfo, Timeline);
registerTemplate(compactInfo, Compact);
registerTemplate(simpleATSInfo, SimpleATS);
registerTemplate(minimalistDesignerInfo, MinimalistDesigner);
registerTemplate(sidebarPhotoLeftInfo, SidebarPhotoLeft);
registerTemplate(sidebarPhotoRightInfo, SidebarPhotoRight);
registerTemplate(boldHeaderInfo, BoldHeader);
registerTemplate(headerPhotoCenteredInfo, HeaderPhotoCentered);
registerTemplate(splitEqualInfo, SplitEqual);
registerTemplate(modernCardsInfo, ModernCards);
registerTemplate(classicSidebarInfo, ClassicSidebar);
registerTemplate(executiveClassicInfo, ExecutiveClassic);
registerTemplate(techModernInfo, TechModern);
registerTemplate(accentLineInfo, AccentLine);
registerTemplate(portfolioDesignerInfo, PortfolioDesigner);
registerTemplate(reactiveClassicInfo, ReactiveClassic);
registerTemplate(reactiveModernInfo, ReactiveModern);
registerTemplate(reactiveCleanInfo, ReactiveClean);
registerTemplate(reactiveEngineeringInfo, ReactiveEngineering);

export function getTemplate(id: string): TemplateRegistryEntry | undefined {
  return registry.get(id);
}

export function getAllTemplates(): TemplateInfo[] {
  return Array.from(registry.values()).map(entry => entry.info);
}

export function getTemplateComponent(id: string): TemplateRegistryEntry['Component'] | undefined {
  return registry.get(id)?.Component;
}

export function getTemplatesByCategory(category: TemplateInfo['category']): TemplateInfo[] {
  return Array.from(registry.values())
    .filter(entry => entry.info.category === category)
    .map(entry => entry.info);
}

export function hasTemplate(id: string): boolean {
  return registry.has(id);
}

export const TEMPLATE_CATEGORIES = [
  { id: 'professional', name: 'Professional', description: 'Clean and corporate-friendly designs' },
  { id: 'modern', name: 'Modern', description: 'Contemporary layouts with creative elements' },
  { id: 'minimal', name: 'Minimal', description: 'Simple and focused on content' },
  { id: 'creative', name: 'Creative', description: 'Bold designs for creative fields' },
  { id: 'classic', name: 'Classic', description: 'Traditional and timeless formats' },
] as const;
