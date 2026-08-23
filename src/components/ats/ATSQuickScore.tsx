import { useState } from "react";
import { motion } from "framer-motion";
import { ScanSearch, Loader2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ResumeData } from "@/types/resume";

// Local deterministic scanner (same logic as backend)
// This runs client-side for instant feedback without network latency

const ACTION_VERBS = [
  'achieved', 'administered', 'analyzed', 'architected', 'automated',
  'built', 'collaborated', 'configured', 'created', 'decreased',
  'delivered', 'designed', 'developed', 'drove', 'eliminated',
  'engineered', 'established', 'executed', 'expanded', 'facilitated',
  'generated', 'grew', 'implemented', 'improved', 'increased',
  'initiated', 'integrated', 'launched', 'led', 'managed',
  'mentored', 'migrated', 'modernized', 'negotiated', 'optimized',
  'orchestrated', 'overhauled', 'pioneered', 'planned', 'produced',
  'programmed', 'proposed', 'reduced', 'refactored', 'resolved',
  'restructured', 'scaled', 'secured', 'shipped', 'simplified',
  'spearheaded', 'streamlined', 'strengthened', 'succeeded', 'supervised',
  'trained', 'transformed', 'upgraded'
];

function calculateDeterministicScore(resumeData: ResumeData): number {
  let score = 0;
  const maxScore = 100;
  
  // 1. Personal Info (15 points)
  const { personalInfo } = resumeData;
  if (personalInfo.fullName?.trim()) score += 3;
  if (personalInfo.email?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personalInfo.email)) score += 4;
  if (personalInfo.phone?.trim()) score += 3;
  if (personalInfo.location?.trim()) score += 2;
  if (personalInfo.linkedin?.trim()) score += 2;
  if (personalInfo.website?.trim()) score += 1;
  
  // 2. Summary (15 points)
  const summaryWords = resumeData.summary?.split(/\s+/).filter(w => w).length || 0;
  if (summaryWords >= 20 && summaryWords <= 200) {
    score += 10;
  } else if (summaryWords >= 10) {
    score += 5;
  }
  // Check for years of experience mention
  if (/\d+\+?\s*(years?|yrs?)/i.test(resumeData.summary || '')) {
    score += 5;
  }
  
  // 3. Experience (30 points)
  const { experience } = resumeData;
  if (experience.length > 0) {
    score += 5; // Has experience section
    
    // Check for bullet points
    const totalBullets = experience.reduce((sum, exp) => sum + exp.bullets.length, 0);
    if (totalBullets >= 6) score += 5;
    else if (totalBullets >= 3) score += 3;
    
    // Check for action verbs
    let actionVerbCount = 0;
    experience.forEach(exp => {
      exp.bullets.forEach(bullet => {
        const firstWord = bullet.trim().split(/\s+/)[0]?.toLowerCase() || '';
        if (ACTION_VERBS.includes(firstWord) || ACTION_VERBS.some(v => bullet.toLowerCase().startsWith(v))) {
          actionVerbCount++;
        }
      });
    });
    const actionVerbRate = totalBullets > 0 ? actionVerbCount / totalBullets : 0;
    if (actionVerbRate >= 0.6) score += 10;
    else if (actionVerbRate >= 0.3) score += 5;
    
    // Check for metrics/quantifiable results
    const allBullets = experience.flatMap(exp => exp.bullets);
    const metricsPattern = /\d+[.,]?\d*\s*(%|percent|\$|dollars|k\b|m\b|users|customers|clients|employees|team|members|projects|x\b|times|hours|days|weeks|months|years)/i;
    const bulletsWithMetrics = allBullets.filter(b => metricsPattern.test(b)).length;
    const metricsRate = allBullets.length > 0 ? bulletsWithMetrics / allBullets.length : 0;
    if (metricsRate >= 0.4) score += 10;
    else if (metricsRate >= 0.2) score += 5;
  }
  
  // 4. Education (10 points)
  const { education } = resumeData;
  if (education.length > 0) {
    score += 5;
    const hasComplete = education.some(edu => edu.degree && edu.institution);
    if (hasComplete) score += 5;
  }
  
  // 5. Skills (20 points)
  const { skills } = resumeData;
  if (skills.length >= 10) score += 15;
  else if (skills.length >= 5) score += 10;
  else if (skills.length > 0) score += 5;
  
  // Check if skills appear in experience (reinforcement)
  if (skills.length > 0 && experience.length > 0) {
    const allText = experience.flatMap(exp => exp.bullets).join(' ').toLowerCase();
    const reinforcedSkills = skills.filter(skill => allText.includes(skill.toLowerCase()));
    if (reinforcedSkills.length >= skills.length * 0.3) score += 5;
  }
  
  // 6. Completeness bonus (10 points)
  const hasSummary = summaryWords >= 10;
  const hasExperience = experience.length > 0;
  const hasEducation = education.length > 0;
  const hasSkills = skills.length >= 5;
  const sectionsComplete = [hasSummary, hasExperience, hasEducation, hasSkills].filter(Boolean).length;
  score += sectionsComplete * 2.5;
  
  return Math.min(Math.round(score), maxScore);
}

interface ATSQuickScoreProps {
  resumeData?: ResumeData;
  onScanComplete?: (score: number) => void;
  className?: string;
  variant?: "card" | "inline";
}

export function ATSQuickScore({ resumeData, onScanComplete, className, variant = "card" }: ATSQuickScoreProps) {
  const [isScanning, setIsScanning] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const hasResumeData = !!resumeData;

  const handleScan = async () => {
    if (!resumeData) {
      return;
    }
    
    setIsScanning(true);
    
    // Small delay for UX feedback
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    // Calculate deterministic score based on resume content
    const calculatedScore = calculateDeterministicScore(resumeData);
    
    setScore(calculatedScore);
    setIsScanning(false);
    onScanComplete?.(calculatedScore);
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-success";
    if (score >= 60) return "text-warning";
    return "text-destructive";
  };

  const getScoreIcon = (score: number) => {
    if (score >= 80) return CheckCircle2;
    if (score >= 60) return AlertTriangle;
    return XCircle;
  };

  const getScoreLabel = (score: number) => {
    if (score >= 85) return "Excellent!";
    if (score >= 70) return "Good";
    if (score >= 50) return "Needs Work";
    return "Low Score";
  };

  if (variant === "inline") {
    return (
      <div className={cn("flex items-center gap-3", className)}>
        {score === null ? (
          hasResumeData ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleScan}
              disabled={isScanning}
              className="gap-2"
            >
              {isScanning ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <ScanSearch className="h-4 w-4" />
                  Check ATS Score
                </>
              )}
            </Button>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground">
              <ScanSearch className="h-4 w-4" />
              Add resume details to scan
            </div>
          )
        ) : (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex items-center gap-2"
          >
            {(() => {
              const Icon = getScoreIcon(score);
              return <Icon className={cn("h-5 w-5", getScoreColor(score))} />;
            })()}
            <span className={cn("font-semibold", getScoreColor(score))}>
              {score}%
            </span>
            <span className="text-sm text-muted-foreground">
              {getScoreLabel(score)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleScan}
              className="ml-2 h-7 px-2 text-xs"
            >
              Rescan
            </Button>
          </motion.div>
        )}
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-border bg-card p-4", className)}>
      {score === null ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
            <ScanSearch className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium text-foreground">
              {hasResumeData ? "Check ATS Compatibility" : "ATS score will appear here"}
            </p>
            <p className="text-sm text-muted-foreground">
              {hasResumeData
                ? "See how well your resume performs with ATS systems"
                : "Add or load resume content to run a quick ATS scan"}
            </p>
          </div>
          <Button
            onClick={handleScan}
            disabled={isScanning || !hasResumeData}
            className="gap-2"
          >
            {isScanning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Scanning...
              </>
            ) : (
              <>
                <ScanSearch className="h-4 w-4" />
                Scan Now
              </>
            )}
          </Button>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-3 text-center"
        >
          <div className={cn(
            "flex h-16 w-16 items-center justify-center rounded-full",
            score >= 80 ? "bg-success/10" : score >= 60 ? "bg-warning/10" : "bg-destructive/10"
          )}>
            {(() => {
              const Icon = getScoreIcon(score);
              return <Icon className={cn("h-8 w-8", getScoreColor(score))} />;
            })()}
          </div>
          <div>
            <p className={cn("text-3xl font-bold", getScoreColor(score))}>
              {score}%
            </p>
            <p className="text-sm text-muted-foreground">
              ATS Compatibility Score
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleScan}
            disabled={isScanning}
            className="gap-2"
          >
            {isScanning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Rescanning...
              </>
            ) : (
              "Scan Again"
            )}
          </Button>
        </motion.div>
      )}
    </div>
  );
}
