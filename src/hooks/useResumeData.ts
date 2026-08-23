import { useState, useCallback } from "react";
import { ResumeData, defaultResumeData, ExperienceItem, EducationItem } from "@/types/resume";

export function useResumeData(initialData: ResumeData = defaultResumeData) {
  const [resumeData, setResumeData] = useState<ResumeData>(initialData);

  const updatePersonalInfo = useCallback(
    (field: keyof ResumeData["personalInfo"], value: string) => {
      setResumeData((prev) => ({
        ...prev,
        personalInfo: {
          ...prev.personalInfo,
          [field]: value,
        },
      }));
    },
    []
  );

  const updateSummary = useCallback((value: string) => {
    setResumeData((prev) => ({
      ...prev,
      summary: value,
    }));
  }, []);

  const updateExperience = useCallback(
    (id: string, field: keyof ExperienceItem, value: string | string[]) => {
      setResumeData((prev) => ({
        ...prev,
        experience: prev.experience.map((exp) =>
          exp.id === id ? { ...exp, [field]: value } : exp
        ),
      }));
    },
    []
  );

  const addExperience = useCallback(() => {
    const newExp: ExperienceItem = {
      id: `exp-${Date.now()}`,
      title: "",
      company: "",
      startDate: "",
      endDate: "",
      description: "",
      bullets: [],
    };
    setResumeData((prev) => ({
      ...prev,
      experience: [...prev.experience, newExp],
    }));
  }, []);

  const removeExperience = useCallback((id: string) => {
    setResumeData((prev) => ({
      ...prev,
      experience: prev.experience.filter((exp) => exp.id !== id),
    }));
  }, []);

  const updateEducation = useCallback(
    (id: string, field: keyof EducationItem, value: string) => {
      setResumeData((prev) => ({
        ...prev,
        education: prev.education.map((edu) =>
          edu.id === id ? { ...edu, [field]: value } : edu
        ),
      }));
    },
    []
  );

  const addEducation = useCallback(() => {
    const newEdu: EducationItem = {
      id: `edu-${Date.now()}`,
      degree: "",
      institution: "",
      field: "",
      graduationYear: "",
    };
    setResumeData((prev) => ({
      ...prev,
      education: [...prev.education, newEdu],
    }));
  }, []);

  const removeEducation = useCallback((id: string) => {
    setResumeData((prev) => ({
      ...prev,
      education: prev.education.filter((edu) => edu.id !== id),
    }));
  }, []);

  const updateSkills = useCallback((skills: string[]) => {
    setResumeData((prev) => ({
      ...prev,
      skills,
    }));
  }, []);

  return {
    resumeData,
    setResumeData,
    updatePersonalInfo,
    updateSummary,
    updateExperience,
    addExperience,
    removeExperience,
    updateEducation,
    addEducation,
    removeEducation,
    updateSkills,
  };
}
