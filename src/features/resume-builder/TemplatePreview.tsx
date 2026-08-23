// TemplatePreview - Shows the actual template design with user data
// Uses generated preview images as the base template design

import { ResumeData } from "@/types/resume";

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

interface TemplatePreviewProps {
  templateId: string;
  templateName: string;
  data: ResumeData;
}

export function TemplatePreview({
  templateId,
  templateName,
  data,
}: TemplatePreviewProps) {
  const previewUrl = `${API_BASE}/api/previews/${encodeURIComponent(templateId)}.png`;

  return (
    <div className="min-h-full bg-neutral-200 dark:bg-neutral-800 py-8 px-4">
      {/* Template Preview Container */}
      <div className="mx-auto max-w-[8.5in] relative">
        {/* Template Name Badge */}
        <div className="absolute -top-6 left-0 text-sm text-muted-foreground font-medium">
          Template: <span className="font-semibold text-foreground">{templateName}</span>
        </div>
        
        {/* Template Preview Image with Data Overlay */}
        <div 
          className="bg-white dark:bg-zinc-900 shadow-xl rounded-sm overflow-hidden relative"
          style={{
            aspectRatio: '8.5/11', // Letter size ratio
            minHeight: '792px', // 11in at 72dpi
          }}
        >
          {/* Background: Template Design Preview */}
          <img
            src={previewUrl}
            alt={`${templateName} template preview`}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => {
              // Fallback to gradient on error
              const target = e.target as HTMLImageElement;
              target.style.display = 'none';
            }}
          />
          
          {/* Overlay with user data - positioned over the preview */}
          <div className="absolute inset-0 p-8 pointer-events-none">
            {/* User's name - positioned at top */}
            <div 
              className="absolute text-2xl font-bold"
              style={{ 
                top: '24px', 
                left: '32px',
                color: 'transparent',
                textShadow: '0 0 0 rgba(0,0,0,0)',
              }}
            >
              {/* Name overlay - hidden, data is shown in preview */}
            </div>
          </div>

          {/* Data Summary Card - shows what will be in the resume */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/50 to-transparent p-6 text-white">
            <div className="text-lg font-semibold mb-2">
              {data.personalInfo.fullName || 'Your Name'}
            </div>
            <div className="text-sm opacity-80 space-x-3">
              {data.personalInfo.email && <span>{data.personalInfo.email}</span>}
              {data.personalInfo.phone && <span>• {data.personalInfo.phone}</span>}
              {data.personalInfo.location && <span>• {data.personalInfo.location}</span>}
            </div>
            <div className="mt-3 text-xs opacity-60 flex gap-4">
              <span>{data.experience.length} Experience{data.experience.length !== 1 ? 's' : ''}</span>
              <span>{data.education.length} Education</span>
              <span>{data.skills.length} Skills</span>
            </div>
          </div>
        </div>

        {/* Export CTA */}
        <div className="mt-4 text-center text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
            Your data will be merged with this template on export
          </span>
        </div>
      </div>
    </div>
  );
}
