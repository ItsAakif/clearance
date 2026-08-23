import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ArrowRight, ArrowLeft, Sparkles, CheckCircle2, FileText, Target } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { BlurText, AnimatedButton, StepIndicator } from "@/components/animations";
import { ATSQuickScore } from "@/components/ats";
import { apiClient } from "@/services/api/client";
import { useToast } from "@/hooks/use-toast";
import type { ResumeData } from "@/types/resume";

// Mirrors backend AIGuidedInput - the questionnaire is the source of truth,
// a job description is optional (see the "Tailor to a job" card).
interface AIBuildData {
  targetRole: string;
  experienceLevel: string;
  currentRole: string;
  yearsExperience: string;
  industry: string;
  highestDegree: string;
  fieldOfStudy: string;
  institution: string;
  technicalSkills: string;
  softSkills: string;
  tools: string;
  achievements: string;
  projectHighlights: string;
}

const initialData: AIBuildData = {
  targetRole: "",
  experienceLevel: "",
  currentRole: "",
  yearsExperience: "",
  industry: "",
  highestDegree: "",
  fieldOfStudy: "",
  institution: "",
  technicalSkills: "",
  softSkills: "",
  tools: "",
  achievements: "",
  projectHighlights: "",
};

const experienceLevels = [
  { value: "entry", label: "Entry Level (0-2 years)" },
  { value: "mid", label: "Mid Level (3-5 years)" },
  { value: "senior", label: "Senior (6-10 years)" },
  { value: "executive", label: "Executive (10+ years)" },
];

const degreeOptions = [
  { value: "high-school", label: "High School" },
  { value: "associate", label: "Associate's Degree" },
  { value: "bachelor", label: "Bachelor's Degree" },
  { value: "master", label: "Master's Degree" },
  { value: "phd", label: "Ph.D. / Doctorate" },
  { value: "other", label: "Other / Certification" },
];

interface GenerateResponse {
  id: string;
  name: string;
  personalInfo: ResumeData["personalInfo"];
  summary: string;
  experience: ResumeData["experience"];
  education: ResumeData["education"];
  skills: string[];
}

export default function AIBuildPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(1);
  const [data, setData] = useState<AIBuildData>(initialData);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGenerated, setIsGenerated] = useState(false);
  const [generatedResumeId, setGeneratedResumeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResumeData | null>(null);

  const totalSteps = 5;

  const updateField = (field: keyof AIBuildData, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }));
  };

  const handleNext = () => {
    if (currentStep < totalSteps) setCurrentStep((prev) => (prev + 1) as 1 | 2 | 3 | 4 | 5);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep((prev) => (prev - 1) as 1 | 2 | 3 | 4 | 5);
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const response = await apiClient.post<GenerateResponse>('/ai/generate-resume', data);
      setGeneratedResumeId(response.id);
      setPreview({
        personalInfo: response.personalInfo,
        summary: response.summary,
        experience: response.experience,
        education: response.education,
        skills: response.skills,
      });
      setIsGenerated(true);
      toast({ title: "Resume drafted!", description: "Review and refine it in the builder." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Generation failed";
      toast({ title: "Generation failed", description: message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleContinue = () => {
    if (generatedResumeId) navigate(`/app/build/${generatedResumeId}`);
    else navigate("/app/build");
  };

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <StepShell title="What role are you targeting?" subtitle="This shapes the language and keywords the AI uses.">
            <div className="space-y-4">
              <div>
                <Label htmlFor="targetRole">Target Job Title</Label>
                <Input
                  id="targetRole"
                  placeholder="e.g., Senior Product Manager"
                  value={data.targetRole}
                  onChange={(e) => updateField("targetRole", e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>Experience Level</Label>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {experienceLevels.map((level) => (
                    <button
                      key={level.value}
                      type="button"
                      onClick={() => updateField("experienceLevel", level.value)}
                      className={`rounded-lg border px-4 py-3 text-left text-sm transition-all ${
                        data.experienceLevel === level.value
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {level.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </StepShell>
        );
      case 2:
        return (
          <StepShell title="Tell us about your background" subtitle="Your most recent or current work.">
            <div className="space-y-4">
              <div>
                <Label htmlFor="currentRole">Current / Most Recent Job Title</Label>
                <Input
                  id="currentRole"
                  placeholder="e.g., Product Manager"
                  value={data.currentRole}
                  onChange={(e) => updateField("currentRole", e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="yearsExperience">Years of Experience</Label>
                <Input
                  id="yearsExperience"
                  placeholder="e.g., 5 years"
                  value={data.yearsExperience}
                  onChange={(e) => updateField("yearsExperience", e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="industry">Industry</Label>
                <Input
                  id="industry"
                  placeholder="e.g., Technology, Finance, Healthcare"
                  value={data.industry}
                  onChange={(e) => updateField("industry", e.target.value)}
                  className="mt-1.5"
                />
              </div>
            </div>
          </StepShell>
        );
      case 3:
        return (
          <StepShell title="What's your educational background?" subtitle="Your highest level of education.">
            <div className="space-y-4">
              <div>
                <Label>Highest Degree</Label>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {degreeOptions.map((degree) => (
                    <button
                      key={degree.value}
                      type="button"
                      onClick={() => updateField("highestDegree", degree.value)}
                      className={`rounded-lg border px-4 py-3 text-left text-sm transition-all ${
                        data.highestDegree === degree.value
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {degree.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label htmlFor="fieldOfStudy">Field of Study</Label>
                <Input
                  id="fieldOfStudy"
                  placeholder="e.g., Computer Science, Business Administration"
                  value={data.fieldOfStudy}
                  onChange={(e) => updateField("fieldOfStudy", e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="institution">Institution</Label>
                <Input
                  id="institution"
                  placeholder="e.g., University of California"
                  value={data.institution}
                  onChange={(e) => updateField("institution", e.target.value)}
                  className="mt-1.5"
                />
              </div>
            </div>
          </StepShell>
        );
      case 4:
        return (
          <StepShell title="What skills do you bring?" subtitle="Technical abilities, soft skills, and tools you use.">
            <div className="space-y-4">
              <div>
                <Label htmlFor="technicalSkills">Technical Skills</Label>
                <Textarea
                  id="technicalSkills"
                  placeholder="e.g., Python, SQL, Data Analysis, Machine Learning..."
                  value={data.technicalSkills}
                  onChange={(e) => updateField("technicalSkills", e.target.value)}
                  className="mt-1.5"
                  rows={2}
                />
              </div>
              <div>
                <Label htmlFor="softSkills">Soft Skills</Label>
                <Textarea
                  id="softSkills"
                  placeholder="e.g., Leadership, Communication, Problem Solving..."
                  value={data.softSkills}
                  onChange={(e) => updateField("softSkills", e.target.value)}
                  className="mt-1.5"
                  rows={2}
                />
              </div>
              <div>
                <Label htmlFor="tools">Tools & Technologies</Label>
                <Textarea
                  id="tools"
                  placeholder="e.g., Jira, Figma, Slack, AWS, Salesforce..."
                  value={data.tools}
                  onChange={(e) => updateField("tools", e.target.value)}
                  className="mt-1.5"
                  rows={2}
                />
              </div>
            </div>
          </StepShell>
        );
      case 5:
        return (
          <StepShell title="Highlight your achievements" subtitle="What are you most proud of?">
            <div className="space-y-4">
              <div>
                <Label htmlFor="achievements">Key Achievements</Label>
                <Textarea
                  id="achievements"
                  placeholder="e.g., Increased revenue by 30%, Led a team of 10 engineers, Launched product to 1M users..."
                  value={data.achievements}
                  onChange={(e) => updateField("achievements", e.target.value)}
                  className="mt-1.5"
                  rows={4}
                />
              </div>
              <div>
                <Label htmlFor="projectHighlights">Notable Projects</Label>
                <Textarea
                  id="projectHighlights"
                  placeholder="Describe 1-2 projects you're proud of and the impact they had..."
                  value={data.projectHighlights}
                  onChange={(e) => updateField("projectHighlights", e.target.value)}
                  className="mt-1.5"
                  rows={4}
                />
              </div>
            </div>
          </StepShell>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <LandingHeader />

      <DotGridSection className="flex items-center justify-center" minHeight="min-h-screen">
        <div className="mx-auto w-full max-w-2xl px-6 py-24 pt-32">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-8"
          >
            <StepIndicator currentStep={currentStep as 1 | 2 | 3} totalSteps={totalSteps} />
          </motion.div>

          <Card className="border border-border bg-card p-6 shadow-lg md:p-8">
            <AnimatePresence mode="wait">
              {isGenerated ? (
                <motion.div
                  key="generated"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="space-y-6"
                >
                  <div className="flex flex-col items-center gap-4 text-center">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 15 }}
                      className="flex h-16 w-16 items-center justify-center rounded-full bg-success/10"
                    >
                      <CheckCircle2 className="h-8 w-8 text-success" />
                    </motion.div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground">Resume Drafted!</h2>
                      <p className="mt-1 text-muted-foreground">
                        The AI built a first draft from your answers. Review and refine it next.
                      </p>
                    </div>
                  </div>

                  <ATSQuickScore variant="card" resumeData={preview ?? undefined} />

                  <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
                    <AnimatedButton variant="hero" onClick={handleContinue} className="gap-2" glowOnHover>
                      Review & Edit in Builder
                      <ArrowRight className="h-4 w-4" />
                    </AnimatedButton>
                  </div>

                  <p className="text-center text-sm text-muted-foreground">
                    Want it tuned to a specific posting?{" "}
                    <Link to="/app/match" className="font-medium text-primary hover:underline">
                      Match it against a job description
                    </Link>
                  </p>
                </motion.div>
              ) : (
                <motion.div key="steps" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
                  <AnimatePresence mode="wait">{renderStep()}</AnimatePresence>

                  {/* Secondary JD path - optional, not required */}
                  <div className="rounded-lg border border-dashed border-border bg-secondary/30 p-4">
                    <div className="flex items-start gap-3">
                      <Target className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                      <div className="text-sm">
                        <p className="font-medium text-foreground">Already have a job description?</p>
                        <p className="text-muted-foreground">
                          You don't need one to build. But if you have a posting, you can match and
                          tailor your resume to it afterwards.
                        </p>
                        <Link
                          to="/app/match"
                          className="mt-1 inline-flex items-center gap-1 font-medium text-primary hover:underline"
                        >
                          Go to Job Match <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {!isGenerated && (
              <div className="mt-8 flex items-center justify-between">
                <Button variant="ghost" onClick={handleBack} disabled={currentStep === 1} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
                {currentStep < totalSteps ? (
                  <AnimatedButton variant="hero" onClick={handleNext} className="gap-2" glowOnHover>
                    Continue
                    <ArrowRight className="h-4 w-4" />
                  </AnimatedButton>
                ) : (
                  <AnimatedButton variant="hero" onClick={handleGenerate} disabled={isGenerating} className="gap-2" glowOnHover>
                    {isGenerating ? (
                      <>
                        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}>
                          <Sparkles className="h-4 w-4" />
                        </motion.div>
                        Building...
                      </>
                    ) : (
                      <>
                        <FileText className="h-4 w-4" />
                        Build My Resume
                      </>
                    )}
                  </AnimatedButton>
                )}
              </div>
            )}
          </Card>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mt-6 flex flex-wrap justify-center gap-2"
          >
            {[
              { step: 1, label: "Target Role" },
              { step: 2, label: "Background" },
              { step: 3, label: "Education" },
              { step: 4, label: "Skills" },
              { step: 5, label: "Achievements" },
            ].map((item) => (
              <div
                key={item.step}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${
                  currentStep > item.step
                    ? "bg-success/10 text-success"
                    : currentStep === item.step
                    ? "bg-primary/10 text-primary"
                    : "bg-secondary text-muted-foreground"
                }`}
              >
                {currentStep > item.step && <CheckCircle2 className="h-3 w-3" />}
                {item.label}
              </div>
            ))}
          </motion.div>
        </div>
      </DotGridSection>

    </div>
  );
}

function StepShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <motion.div
      key={title}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="space-y-6"
    >
      <div className="text-center">
        <BlurText text={title} className="text-xl font-semibold text-foreground md:text-2xl" as="h2" animateBy="words" delay={40} />
        <p className="mt-2 text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </motion.div>
  );
}
