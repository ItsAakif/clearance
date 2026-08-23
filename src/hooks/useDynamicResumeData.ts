// Dynamic Resume Data Hook - Manages flexible section-based resume data
// Supports any template structure with dynamic sections

import { useState, useCallback } from "react";
import {
  DynamicResumeData,
  DynamicSectionData,
  SectionDefinition,
  TemplateInfo,
  defaultDynamicResumeData,
  createSampleDynamicData,
} from "@/types/resume";

// ==================== HOOK ====================

export function useDynamicResumeData(initialData: DynamicResumeData = defaultDynamicResumeData) {
  const [data, setData] = useState<DynamicResumeData>(initialData);

  /**
   * Initialize data for a new template
   * Creates empty sections based on template definition
   */
  const initializeForTemplate = useCallback((template: TemplateInfo) => {
    setData(createSampleDynamicData(template));
  }, []);

  /**
   * Set the entire resume data (for loading saved resumes)
   */
  const setResumeData = useCallback((newData: DynamicResumeData) => {
    setData(newData);
  }, []);

  /**
   * Update a single-value section (text, summary, etc.)
   */
  const updateSectionValue = useCallback(
    (sectionId: string, value: string | string[]) => {
      setData((prev) => ({
        ...prev,
        sections: {
          ...prev.sections,
          [sectionId]: {
            ...prev.sections[sectionId],
            value,
          },
        },
      }));
    },
    []
  );

  /**
   * Update a field within an entry (for repeatable sections)
   */
  const updateEntryField = useCallback(
    (sectionId: string, entryId: string, field: string, value: unknown) => {
      console.log('[updateEntryField]', sectionId, entryId, field, value);
      setData((prev) => {
        const section = prev.sections[sectionId];
        if (!section?.entries) return prev;

        return {
          ...prev,
          sections: {
            ...prev.sections,
            [sectionId]: {
              ...section,
              entries: section.entries.map((entry) =>
                entry.id === entryId ? { ...entry, [field]: value } : entry
              ),
            },
          },
        };
      });
    },
    []
  );

  /**
   * Add a new entry to a repeatable section
   */
  const addEntry = useCallback(
    (sectionId: string, sectionDef: SectionDefinition) => {
      const newEntry: Record<string, unknown> & { id: string } = {
        id: `${sectionId}-${Date.now()}`,
      };

      // Initialize all fields with empty values
      const fieldsToUse = sectionDef.entryFields || sectionDef.fields;
      for (const field of fieldsToUse) {
        if (field.type === "list") {
          newEntry[field.name] = [];
        } else {
          newEntry[field.name] = "";
        }
      }

      setData((prev) => {
        const section = prev.sections[sectionId] || { entries: [] };
        return {
          ...prev,
          sections: {
            ...prev.sections,
            [sectionId]: {
              ...section,
              entries: [...(section.entries || []), newEntry],
            },
          },
        };
      });
    },
    []
  );

  /**
   * Remove an entry from a repeatable section
   */
  const removeEntry = useCallback((sectionId: string, entryId: string) => {
    setData((prev) => {
      const section = prev.sections[sectionId];
      if (!section?.entries) return prev;

      return {
        ...prev,
        sections: {
          ...prev.sections,
          [sectionId]: {
            ...section,
            entries: section.entries.filter((entry) => entry.id !== entryId),
          },
        },
      };
    });
  }, []);

  /**
   * Reorder entries within a section (for drag and drop)
   */
  const reorderEntries = useCallback(
    (sectionId: string, fromIndex: number, toIndex: number) => {
      setData((prev) => {
        const section = prev.sections[sectionId];
        if (!section?.entries) return prev;

        const entries = [...section.entries];
        const [removed] = entries.splice(fromIndex, 1);
        entries.splice(toIndex, 0, removed);

        return {
          ...prev,
          sections: {
            ...prev.sections,
            [sectionId]: {
              ...section,
              entries,
            },
          },
        };
      });
    },
    []
  );

  /**
   * Get section data (with fallback for missing sections)
   */
  const getSection = useCallback(
    (sectionId: string): DynamicSectionData => {
      return data.sections[sectionId] || { value: "", entries: [] };
    },
    [data.sections]
  );

  /**
   * Get a specific entry from a section
   */
  const getEntry = useCallback(
    (sectionId: string, entryId: string): Record<string, unknown> | null => {
      const section = data.sections[sectionId];
      if (!section?.entries) return null;
      return section.entries.find((e) => e.id === entryId) || null;
    },
    [data.sections]
  );

  /**
   * Check if section has any content
   */
  const isSectionEmpty = useCallback(
    (sectionId: string): boolean => {
      const section = data.sections[sectionId];
      if (!section) return true;

      if (section.entries) {
        return section.entries.length === 0;
      }

      if (Array.isArray(section.value)) {
        return section.value.length === 0;
      }

      return !section.value || section.value === "";
    },
    [data.sections]
  );

  return {
    data,
    setResumeData,
    initializeForTemplate,
    updateSectionValue,
    updateEntryField,
    addEntry,
    removeEntry,
    reorderEntries,
    getSection,
    getEntry,
    isSectionEmpty,
  };
}

export type UseDynamicResumeDataReturn = ReturnType<typeof useDynamicResumeData>;
