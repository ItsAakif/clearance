import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { renderAsync } from 'docx-preview';
import type { DynamicResumeData, TemplateInfo, SectionDefinition } from '@/types/resume';
import { Loader2, AlertCircle, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UseDynamicResumeDataReturn } from '@/hooks/useDynamicResumeData';
import './DocxPreview.css';

interface DocxPreviewProps {
  templateId: string;
  data: DynamicResumeData;
  scale?: number;
  // New props for inline editing mode
  template?: TemplateInfo;
  resumeData?: UseDynamicResumeDataReturn;
  editable?: boolean;
  // Legacy callback (still supported)
  onContentChange?: (field: string, value: string) => void;
}

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// Field mapping types
interface FieldMapping {
  element: HTMLElement;
  path: string; // e.g., "header.fullName", "experience.0.title", "summary"
  sectionId: string;
  entryId?: string;
  fieldName?: string;
  originalValue: string;
}

export function DocxPreview({ 
  templateId, 
  data, 
  scale = 1, 
  template,
  resumeData,
  editable = true,
  onContentChange 
}: DocxPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fieldMappingsRef = useRef<FieldMapping[]>([]);
  const [hoveredSection, setHoveredSection] = useState<string | null>(null);

  const dataHash = useMemo(() => JSON.stringify({ sections: data.sections, originalValues: data.originalValues }), [data]);

  // Build a lookup map from original values to field paths
  const buildOriginalValuesMap = useCallback(() => {
    const map = new Map<string, { path: string; sectionId: string; entryId?: string; fieldName?: string }>();
    const originalValues = data.originalValues || {};
    const sections = data.sections || {};

    // Map from originalValues (template text -> field path)
    for (const [key, value] of Object.entries(originalValues)) {
      if (!value || typeof value !== 'string') continue;
      
      // Parse the key to determine section and field
      // Keys like: fullName, email, exp_0_title, edu_1_institution, summary, skills
      if (key === 'fullName' || key === 'email' || key === 'phone' || key === 'location' || key === 'linkedin' || key === 'website') {
        const entryId = sections.header?.entries?.[0]?.id;
        map.set(value.trim(), { path: `header.${key}`, sectionId: 'header', entryId, fieldName: key });
      } else if (key === 'summary') {
        map.set(value.trim(), { path: 'summary', sectionId: 'summary' });
      } else if (key === 'skills') {
        map.set(value.trim(), { path: 'skills', sectionId: 'skills' });
      } else if (key.startsWith('exp_')) {
        const match = key.match(/exp_(\d+)_(\w+)/);
        if (match) {
          const idx = parseInt(match[1]);
          const fieldName = match[2];
          const entryId = sections.experience?.entries?.[idx]?.id;
          map.set(value.trim(), { path: `experience.${idx}.${fieldName}`, sectionId: 'experience', entryId, fieldName });
        }
      } else if (key.startsWith('edu_')) {
        const match = key.match(/edu_(\d+)_(\w+)/);
        if (match) {
          const idx = parseInt(match[1]);
          const fieldName = match[2];
          const entryId = sections.education?.entries?.[idx]?.id;
          map.set(value.trim(), { path: `education.${idx}.${fieldName}`, sectionId: 'education', entryId, fieldName });
        }
      }
    }

    // Also map current values for fields that may have been edited
    // Header fields
    const headerEntry = sections.header?.entries?.[0];
    if (headerEntry) {
      const entryId = headerEntry.id;
      for (const field of ['fullName', 'name', 'email', 'phone', 'location', 'address', 'linkedin', 'website']) {
        const val = headerEntry[field as keyof typeof headerEntry];
        if (val && typeof val === 'string' && val.trim()) {
          const normalizedField = field === 'name' ? 'fullName' : field === 'address' ? 'location' : field;
          if (!map.has(val.trim())) {
            map.set(val.trim(), { path: `header.${normalizedField}`, sectionId: 'header', entryId, fieldName: normalizedField });
          }
        }
      }
    }

    // Summary
    const summaryVal = sections.summary?.value;
    if (typeof summaryVal === 'string' && summaryVal.trim() && !map.has(summaryVal.trim())) {
      map.set(summaryVal.trim(), { path: 'summary', sectionId: 'summary' });
    }

    // Experience entries
    const expEntries = sections.experience?.entries || [];
    expEntries.forEach((entry, idx) => {
      const entryId = entry.id;
      for (const field of ['title', 'position', 'company', 'employer', 'startDate', 'endDate', 'description']) {
        const val = entry[field as keyof typeof entry];
        if (val && typeof val === 'string' && val.trim()) {
          const normalizedField = field === 'position' ? 'title' : field === 'employer' ? 'company' : field;
          if (!map.has(val.trim())) {
            map.set(val.trim(), { path: `experience.${idx}.${normalizedField}`, sectionId: 'experience', entryId, fieldName: normalizedField });
          }
        }
      }
      // Bullets
      const bullets = entry.bullets as string[] | undefined;
      if (bullets && Array.isArray(bullets)) {
        bullets.forEach((bullet, bulletIdx) => {
          if (bullet && typeof bullet === 'string' && bullet.trim()) {
            if (!map.has(bullet.trim())) {
              map.set(bullet.trim(), { path: `experience.${idx}.bullets.${bulletIdx}`, sectionId: 'experience', entryId, fieldName: `bullets.${bulletIdx}` });
            }
          }
        });
      }
    });

    // Education entries
    const eduEntries = sections.education?.entries || [];
    eduEntries.forEach((entry, idx) => {
      const entryId = entry.id;
      for (const field of ['degree', 'institution', 'university', 'school', 'field', 'major', 'graduationYear']) {
        const val = entry[field as keyof typeof entry];
        if (val && typeof val === 'string' && val.trim()) {
          const normalizedField = ['university', 'school'].includes(field) ? 'institution' : field === 'major' ? 'field' : field;
          if (!map.has(val.trim())) {
            map.set(val.trim(), { path: `education.${idx}.${normalizedField}`, sectionId: 'education', entryId, fieldName: normalizedField });
          }
        }
      }
    });

    // Skills
    const skillsVal = sections.skills?.value;
    if (Array.isArray(skillsVal)) {
      const skillsText = skillsVal.join(', ');
      if (!map.has(skillsText)) {
        map.set(skillsText, { path: 'skills', sectionId: 'skills' });
      }
      // Also individual skills
      skillsVal.forEach((skill, idx) => {
        if (typeof skill === 'string' && skill.trim() && !map.has(skill.trim())) {
          map.set(skill.trim(), { path: `skills.${idx}`, sectionId: 'skills', fieldName: `${idx}` });
        }
      });
    } else if (typeof skillsVal === 'string' && skillsVal.trim() && !map.has(skillsVal.trim())) {
      map.set(skillsVal.trim(), { path: 'skills', sectionId: 'skills' });
    }

    return map;
  }, [data.originalValues, data.sections]);

  // Make content editable and map fields
  const makeContentEditable = useCallback((container: HTMLElement) => {
    if (!editable) return;
    
    const valuesMap = buildOriginalValuesMap();
    const mappings: FieldMapping[] = [];
    const textElements = container.querySelectorAll('p, span, h1, h2, h3, h4, h5, h6, td, li');
    let unmappedIndex = 0;

    textElements.forEach((el) => {
      const htmlEl = el as HTMLElement;
      const text = htmlEl.textContent?.trim();

      if (text && text.length > 0 && !htmlEl.querySelector('*[contenteditable]')) {
        htmlEl.contentEditable = 'true';
        htmlEl.classList.add('docx-editable');

        // Try to find a match in our values map
        let mapping: FieldMapping | null = null;
        
        // Exact match first
        if (valuesMap.has(text)) {
          const info = valuesMap.get(text)!;
          mapping = {
            element: htmlEl,
            path: info.path,
            sectionId: info.sectionId,
            entryId: info.entryId,
            fieldName: info.fieldName,
            originalValue: text,
          };
        } else {
          // Try partial match (for texts that contain the value)
          for (const [value, info] of valuesMap.entries()) {
            if (text.includes(value) && value.length > 3) {
              mapping = {
                element: htmlEl,
                path: info.path,
                sectionId: info.sectionId,
                entryId: info.entryId,
                fieldName: info.fieldName,
                originalValue: value,
              };
              break;
            }
          }
        }

        if (mapping) {
          htmlEl.dataset.fieldPath = mapping.path;
          htmlEl.dataset.sectionId = mapping.sectionId;
          if (mapping.entryId) htmlEl.dataset.entryId = mapping.entryId;
          if (mapping.fieldName) htmlEl.dataset.fieldName = mapping.fieldName;
          mappings.push(mapping);
        } else {
          // Unmapped field - use generic ID but try to infer from position
          htmlEl.dataset.fieldPath = `unmapped.${unmappedIndex++}`;
        }

        // Add event listeners
        htmlEl.addEventListener('blur', handleFieldBlur);
        htmlEl.addEventListener('focus', handleFieldFocus);
        htmlEl.addEventListener('keydown', handleKeyDown);
      }
    });

    fieldMappingsRef.current = mappings;
    console.log('[DocxPreview] Field mappings created:', mappings.length);
  }, [editable, buildOriginalValuesMap]);

  const handleFieldBlur = useCallback((e: Event) => {
    const target = e.target as HTMLElement;
    const newValue = target.textContent || '';
    const fieldPath = target.dataset.fieldPath;
    const sectionId = target.dataset.sectionId;
    const entryId = target.dataset.entryId;
    const fieldName = target.dataset.fieldName;

    target.classList.remove('docx-editing');

    console.log('[DocxPreview] Field blur:', { fieldPath, sectionId, entryId, fieldName, newValue });

    // If we have resumeData, update through the hook
    if (resumeData && sectionId && fieldPath && !fieldPath.startsWith('unmapped')) {
      if (sectionId === 'summary') {
        resumeData.updateSectionValue('summary', newValue);
      } else if (sectionId === 'skills') {
        // Skills can be comma-separated
        if (fieldPath === 'skills') {
          const skills = newValue.split(',').map(s => s.trim()).filter(Boolean);
          resumeData.updateSectionValue('skills', skills);
        }
      } else if (entryId && fieldName) {
        // Handle bullet updates
        if (fieldName.startsWith('bullets.')) {
          const bulletIdx = parseInt(fieldName.split('.')[1]);
          const entry = resumeData.getEntry(sectionId, entryId);
          if (entry) {
            const bullets = [...(entry.bullets as string[] || [])];
            bullets[bulletIdx] = newValue;
            resumeData.updateEntryField(sectionId, entryId, 'bullets', bullets);
          }
        } else {
          resumeData.updateEntryField(sectionId, entryId, fieldName, newValue);
        }
      }
    }

    // Also call legacy callback if provided
    onContentChange?.(fieldPath || '', newValue);
  }, [resumeData, onContentChange]);

  const handleFieldFocus = useCallback((e: Event) => {
    const target = e.target as HTMLElement;
    target.classList.add('docx-editing');
    
    // Track which section is being edited
    const sectionId = target.dataset.sectionId;
    if (sectionId) {
      setHoveredSection(sectionId);
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const fieldName = target.dataset.fieldName;
    
    // Handle Enter key for bullets
    if (e.key === 'Enter' && fieldName?.startsWith('bullets.')) {
      e.preventDefault();
      // For now, just blur to save. Later can implement adding new bullet
      target.blur();
    }
    
    // Prevent Enter from creating new lines in single-line fields
    if (e.key === 'Enter' && !fieldName?.startsWith('bullets.') && target.dataset.sectionId !== 'summary') {
      e.preventDefault();
      target.blur();
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    debounceRef.current = setTimeout(async () => {
      if (!containerRef.current || !templateId) return;
      
      setLoading(true);
      setError(null);
      
      abortControllerRef.current = new AbortController();
      
      try {
        console.log('[DocxPreview] Sending request with:', {
          sections: data.sections,
          originalValues: data.originalValues
        });
        
        const response = await fetch(`${API_BASE}/templates/${templateId}/preview-blob`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            sections: data.sections,
            originalValues: data.originalValues 
          }),
          signal: abortControllerRef.current.signal,
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to load preview (${response.status})`);
        }
        
        const blob = await response.blob();
        
        if (containerRef.current) {
          containerRef.current.innerHTML = '';
          
          await renderAsync(blob, containerRef.current, undefined, {
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            renderHeaders: true,
            renderFooters: true,
            breakPages: true,
            renderEndnotes: true,
            renderFootnotes: true,
          });
          
          makeContentEditable(containerRef.current);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }
        console.error('DocxPreview error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load preview');
      } finally {
        setLoading(false);
      }
    }, 500);
    
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [templateId, dataHash, makeContentEditable]);

  const handleRetry = () => {
    setError(null);
    setLoading(true);
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      const event = new Event('retry');
      window.dispatchEvent(event);
    }, 0);
  };

  // Get section definition for add button
  const getSectionDef = (sectionId: string): SectionDefinition | undefined => {
    return template?.sections.find(s => s.id.toLowerCase() === sectionId.toLowerCase());
  };

  // Handle adding entry to repeatable section
  const handleAddEntry = (sectionId: string) => {
    const sectionDef = getSectionDef(sectionId);
    if (sectionDef && resumeData) {
      resumeData.addEntry(sectionId, sectionDef);
    }
  };

  if (error) {
    return (
      <div className="docx-preview-error">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h3>Preview Failed</h3>
        <p>{error}</p>
        <Button onClick={handleRetry} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="docx-preview-wrapper">
      {loading && (
        <div className="docx-preview-loading">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span>Rendering template...</span>
        </div>
      )}
      
      {/* Section controls overlay */}
      {editable && resumeData && template && !loading && (
        <div className="docx-section-controls">
          {template.sections
            .filter(s => s.isRepeatable)
            .map(section => (
              <div 
                key={section.id} 
                className="docx-section-control"
                data-section={section.id}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="docx-add-button"
                  onClick={() => handleAddEntry(section.id)}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add {section.name.replace(/s$/, '')}
                </Button>
              </div>
            ))}
        </div>
      )}
      
      <div 
        ref={containerRef} 
        className="docx-preview-container"
        style={{ 
          transform: `scale(${scale})`, 
          transformOrigin: 'top center',
          opacity: loading ? 0.3 : 1,
        }}
      />
    </div>
  );
}

export default DocxPreview;
