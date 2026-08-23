import { useCallback, useRef, useState, useMemo } from 'react';
import { ResumeData, ExperienceItem, EducationItem, CustomSection, ResumePage } from '@/types/resume';
import { getTemplateComponent } from './registry';
import { TemplateCustomization, defaultCustomization } from './types';
import { RichTextToolbar } from './RichTextToolbar';
import { AddSection } from './AddSection';
import { PageManager, createNewPage, duplicatePage } from '../components/PageManager';

interface TemplateRendererProps {
  templateId: string;
  data: ResumeData;
  customization?: TemplateCustomization;
  editable?: boolean;
  scale?: number;
  onDataChange?: (data: ResumeData) => void;
  onCustomizationChange?: (customization: Partial<TemplateCustomization>) => void;
  onPhotoUpload?: (file: File) => Promise<string>;
  showPageManager?: boolean;
}

export function TemplateRenderer({
  templateId,
  data,
  customization = defaultCustomization,
  editable = true,
  scale = 1,
  onDataChange,
  onCustomizationChange,
  onPhotoUpload,
  showPageManager = true,
}: TemplateRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  
  const TemplateComponent = getTemplateComponent(templateId);

  const pages = useMemo(() => {
    if (data.pages && data.pages.length > 0) {
      return data.pages;
    }
    return [createNewPage(1)];
  }, [data.pages]);

  const handleFieldChange = useCallback((path: string, value: string | string[]) => {
    if (!onDataChange) return;

    const newData = { ...data };
    const parts = path.split('.');

    if (parts[0] === 'personalInfo') {
      newData.personalInfo = {
        ...newData.personalInfo,
        [parts[1]]: value as string,
      };
    } else if (parts[0] === 'summary') {
      newData.summary = value as string;
    } else if (parts[0] === 'skills') {
      newData.skills = value as string[];
    } else if (parts[0] === 'experience') {
      if (parts[1] === 'add') {
        const newEntry: ExperienceItem = {
          id: `exp-${Date.now()}`,
          title: '',
          company: '',
          startDate: '',
          endDate: '',
          description: '',
          bullets: [''],
        };
        newData.experience = [...newData.experience, newEntry];
      } else {
        const index = parseInt(parts[1]);
        if (parts[2] === 'delete') {
          newData.experience = newData.experience.filter((_, i) => i !== index);
        } else if (parts[2] === 'bullets') {
          newData.experience = newData.experience.map((exp, i) =>
            i === index ? { ...exp, bullets: value as string[] } : exp
          );
        } else {
          newData.experience = newData.experience.map((exp, i) =>
            i === index ? { ...exp, [parts[2]]: value as string } : exp
          );
        }
      }
    } else if (parts[0] === 'education') {
      if (parts[1] === 'add') {
        const newEntry: EducationItem = {
          id: `edu-${Date.now()}`,
          degree: '',
          institution: '',
          field: '',
          graduationYear: '',
        };
        newData.education = [...newData.education, newEntry];
      } else {
        const index = parseInt(parts[1]);
        if (parts[2] === 'delete') {
          newData.education = newData.education.filter((_, i) => i !== index);
        } else {
          newData.education = newData.education.map((edu, i) =>
            i === index ? { ...edu, [parts[2]]: value as string } : edu
          );
        }
      }
    } else if (parts[0] === 'customSection') {
      if (parts[1] === 'add') {
        const newSection = value as unknown as CustomSection;
        newData.customSections = [...(newData.customSections || []), newSection];
      } else {
        const sectionIndex = parseInt(parts[1]);
        if (parts[2] === 'delete') {
          newData.customSections = (newData.customSections || []).filter((_, i) => i !== sectionIndex);
        } else if (parts[2] === 'title') {
          newData.customSections = (newData.customSections || []).map((sec, i) =>
            i === sectionIndex ? { ...sec, title: value as string } : sec
          );
        } else if (parts[2] === 'content') {
          newData.customSections = (newData.customSections || []).map((sec, i) =>
            i === sectionIndex ? { ...sec, content: value as string } : sec
          );
        } else if (parts[2] === 'entry') {
          if (parts[3] === 'add') {
            const newEntry = {
              id: `entry-${Date.now()}`,
              title: '',
              subtitle: '',
              date: '',
              description: '',
              bullets: [],
            };
            newData.customSections = (newData.customSections || []).map((sec, i) =>
              i === sectionIndex ? { ...sec, entries: [...(sec.entries || []), newEntry] } : sec
            );
          } else {
            const entryIndex = parseInt(parts[3]);
            if (parts[4] === 'delete') {
              newData.customSections = (newData.customSections || []).map((sec, i) =>
                i === sectionIndex
                  ? { ...sec, entries: (sec.entries || []).filter((_, ei) => ei !== entryIndex) }
                  : sec
              );
            } else {
              const fieldName = parts[4];
              newData.customSections = (newData.customSections || []).map((sec, i) =>
                i === sectionIndex
                  ? {
                      ...sec,
                      entries: (sec.entries || []).map((entry, ei) =>
                        ei === entryIndex ? { ...entry, [fieldName]: value } : entry
                      ),
                    }
                  : sec
              );
            }
          }
        }
      }
    }

    onDataChange(newData);
  }, [data, onDataChange]);

  const handleAddCustomSection = useCallback((section: CustomSection) => {
    if (!onDataChange) return;
    const newData = { 
      ...data, 
      customSections: [...(data.customSections || []), section] 
    };
    onDataChange(newData);
  }, [data, onDataChange]);

  const handleAddPage = useCallback(() => {
    if (!onDataChange) return;
    const newPage = createNewPage(pages.length + 1);
    const newPages = [...pages, newPage];
    onDataChange({ ...data, pages: newPages });
    setCurrentPageIndex(newPages.length - 1);
  }, [data, pages, onDataChange]);

  const handleDuplicatePage = useCallback((index: number) => {
    if (!onDataChange) return;
    const pageToDuplicate = pages[index];
    const newPage = duplicatePage(pageToDuplicate, pages.length + 1);
    const newPages = [...pages, newPage];
    onDataChange({ ...data, pages: newPages });
    setCurrentPageIndex(newPages.length - 1);
  }, [data, pages, onDataChange]);

  const handleDeletePage = useCallback((index: number) => {
    if (!onDataChange || pages.length <= 1) return;
    const newPages = pages.filter((_, i) => i !== index).map((page, i) => ({
      ...page,
      pageNumber: i + 1,
    }));
    onDataChange({ ...data, pages: newPages });
    setCurrentPageIndex(Math.min(currentPageIndex, newPages.length - 1));
  }, [data, pages, currentPageIndex, onDataChange]);

  const handlePageChange = useCallback((index: number) => {
    setCurrentPageIndex(Math.max(0, Math.min(index, pages.length - 1)));
  }, [pages.length]);

  if (!TemplateComponent) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium">Template not found</p>
          <p className="text-sm">Template "{templateId}" is not available</p>
        </div>
      </div>
    );
  }

  const currentPage = pages[currentPageIndex];
  const isFirstPage = currentPageIndex === 0;
  const dataForPage = isFirstPage ? data : {
    ...data,
    personalInfo: { fullName: '', email: '', phone: '', location: '' },
    summary: '',
    experience: [],
    education: [],
    skills: [],
    customSections: currentPage?.customContent || [],
  };

  return (
    <div className="template-renderer-wrapper flex flex-col">
      {showPageManager && editable && pages.length > 0 && (
        <PageManager
          pages={pages}
          currentPageIndex={currentPageIndex}
          onPageChange={handlePageChange}
          onAddPage={handleAddPage}
          onDuplicatePage={handleDuplicatePage}
          onDeletePage={handleDeletePage}
          editable={editable}
        />
      )}
      
      <div 
        ref={containerRef}
        className="template-renderer-container relative flex-1"
      >
        {editable && <RichTextToolbar containerRef={containerRef} />}
        <TemplateComponent
          data={dataForPage}
          customization={customization}
          editable={editable}
          onFieldChange={handleFieldChange}
          onCustomizationChange={onCustomizationChange}
          onPhotoUpload={onPhotoUpload}
          scale={scale}
        />
        {editable && (
          <div className="px-8 pb-8">
            <AddSection onAddSection={handleAddCustomSection} />
          </div>
        )}
      </div>
    </div>
  );
}

interface MultiPageRendererProps {
  templateId: string;
  data: ResumeData;
  customization?: TemplateCustomization;
  scale?: number;
}

export function MultiPageRenderer({
  templateId,
  data,
  customization = defaultCustomization,
  scale = 1,
}: MultiPageRendererProps) {
  const TemplateComponent = getTemplateComponent(templateId);
  
  if (!TemplateComponent) {
    return null;
  }

  const pages = data.pages && data.pages.length > 0 
    ? data.pages 
    : [createNewPage(1)];

  return (
    <div className="multi-page-renderer flex flex-col gap-8">
      {pages.map((page, index) => {
        const isFirstPage = index === 0;
        const dataForPage = isFirstPage ? data : {
          ...data,
          personalInfo: { fullName: '', email: '', phone: '', location: '' },
          summary: '',
          experience: [],
          education: [],
          skills: [],
          customSections: page.customContent || [],
        };

        return (
          <div key={page.id} className="page-wrapper relative">
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-xs text-muted-foreground">
              Page {index + 1} of {pages.length}
            </div>
            <TemplateComponent
              data={dataForPage}
              customization={customization}
              editable={false}
              scale={scale}
            />
          </div>
        );
      })}
    </div>
  );
}

export function getTemplateHtml(templateId: string, data: ResumeData): string | null {
  return null;
}
