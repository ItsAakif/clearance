import { ReactNode } from 'react';
import { ResumeData } from '@/types/resume';

export type FontFamily = 'inter' | 'roboto' | 'playfair' | 'montserrat' | 'lato' | 'merriweather';
export type FontSize = 'small' | 'medium' | 'large';

export type SpacingSize = 'none' | 'tight' | 'normal' | 'relaxed' | 'loose';

export interface SpacingSettings {
  sectionGap: SpacingSize;
  itemGap: SpacingSize;
  lineHeight: SpacingSize;
  pagePadding: SpacingSize;
}

export interface LayoutSettings {
  sidebarWidth?: number;
  headerHeight?: number;
  columnRatio?: number;
  spacing?: SpacingSettings;
}

export interface TemplateCustomization {
  primaryColor: string;
  secondaryColor: string;
  fontFamily: FontFamily;
  fontSize: FontSize;
  headingStyle: 'uppercase' | 'normal' | 'capitalize';
  photoUrl?: string;
  photoSize?: 'small' | 'medium' | 'large' | 'xlarge';
  layout?: LayoutSettings;
}

export const defaultSpacing: SpacingSettings = {
  sectionGap: 'tight',
  itemGap: 'tight',
  lineHeight: 'tight',
  pagePadding: 'normal',
};

export const spacingValues = {
  sectionGap: { none: '0', tight: '0.35rem', normal: '0.75rem', relaxed: '1.25rem', loose: '1.75rem' },
  itemGap: { none: '0', tight: '0.1rem', normal: '0.25rem', relaxed: '0.4rem', loose: '0.6rem' },
  lineHeight: { none: '1', tight: '1.25', normal: '1.4', relaxed: '1.55', loose: '1.7' },
  pagePadding: { none: '0.5rem', tight: '1rem', normal: '1.5rem', relaxed: '2rem', loose: '2.5rem' },
};

export const defaultCustomization: TemplateCustomization = {
  primaryColor: '#1e293b',
  secondaryColor: '#3b82f6',
  fontFamily: 'inter',
  fontSize: 'medium',
  headingStyle: 'uppercase',
  layout: {
    sidebarWidth: 280,
    headerHeight: 200,
    columnRatio: 50,
    spacing: defaultSpacing,
  },
};

export interface TemplateProps {
  data: ResumeData;
  customization?: TemplateCustomization;
  editable?: boolean;
  onFieldChange?: (path: string, value: string | string[]) => void;
  onCustomizationChange?: (customization: Partial<TemplateCustomization>) => void;
  onPhotoUpload?: (file: File) => Promise<string>;
  scale?: number;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  thumbnail?: string;
  isAtsOptimized: boolean;
}

export type TemplateCategory = 
  | 'professional' 
  | 'modern' 
  | 'minimal' 
  | 'creative' 
  | 'classic';

export interface TemplateComponent {
  (props: TemplateProps): ReactNode;
}

export interface TemplateRegistryEntry {
  info: TemplateInfo;
  Component: TemplateComponent;
}

export type FieldPath = 
  | `personalInfo.${keyof ResumeData['personalInfo']}`
  | 'summary'
  | `experience.${number}.${string}`
  | `education.${number}.${string}`
  | `skills.${number}`;

export function getSpacing(customization?: TemplateCustomization) {
  const spacing = customization?.layout?.spacing || defaultSpacing;
  return {
    sectionGap: spacingValues.sectionGap[spacing.sectionGap],
    itemGap: spacingValues.itemGap[spacing.itemGap],
    lineHeight: spacingValues.lineHeight[spacing.lineHeight],
    pagePadding: spacingValues.pagePadding[spacing.pagePadding],
  };
}
