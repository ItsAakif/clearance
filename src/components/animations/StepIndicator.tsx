"use client";

import { cn } from "@/lib/utils";

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
  className?: string;
}

/**
 * Progress as a ruled measure: one hairline per step, ink for the ones done.
 * No circles, no pulse ring, no spring - a step count is a fact, not a moment.
 */
export default function StepIndicator({ currentStep, totalSteps, className }: StepIndicatorProps) {
  const steps = Array.from({ length: totalSteps }, (_, i) => i + 1);

  return (
    <div
      className={cn("flex items-center gap-2", className)}
      role="progressbar"
      aria-valuenow={currentStep}
      aria-valuemin={1}
      aria-valuemax={totalSteps}
      aria-label={`Step ${currentStep} of ${totalSteps}`}
    >
      {steps.map((step) => (
        <span
          key={step}
          className={cn("h-0.5 flex-1", step <= currentStep ? "bg-ink" : "bg-rule")}
        />
      ))}
    </div>
  );
}
