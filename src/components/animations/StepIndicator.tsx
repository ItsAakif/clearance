"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
  className?: string;
}

export default function StepIndicator({ currentStep, totalSteps, className }: StepIndicatorProps) {
  const steps = Array.from({ length: totalSteps }, (_, i) => i + 1);

  return (
    <div className={cn("flex items-center justify-center gap-0", className)}>
      {steps.map((step, index) => (
        <div key={step} className="flex items-center">
          {/* Step circle */}
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: index * 0.1, type: "spring", stiffness: 300 }}
            className="relative"
          >
            <motion.div
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-semibold transition-all duration-300",
                step < currentStep && "border-primary bg-primary text-primary-foreground",
                step === currentStep && "border-primary bg-primary text-primary-foreground shadow-lg",
                step > currentStep && "border-muted-foreground/30 bg-background text-muted-foreground"
              )}
              whileHover={{ scale: 1.1 }}
            >
              {step < currentStep ? (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 400 }}
                >
                  <Check className="h-5 w-5" />
                </motion.div>
              ) : (
                step
              )}
            </motion.div>

            {/* Pulse ring for current step */}
            {step === currentStep && (
              <motion.div
                className="absolute inset-0 rounded-full border-2 border-primary"
                initial={{ scale: 1, opacity: 0.5 }}
                animate={{ scale: 1.5, opacity: 0 }}
                transition={{ duration: 1.5, repeat: Infinity }}
              />
            )}
          </motion.div>

          {/* Connector line */}
          {index < steps.length - 1 && (
            <div className="relative mx-2 h-0.5 w-24 overflow-hidden rounded-full bg-muted-foreground/20 md:w-32">
              <motion.div
                className="absolute inset-y-0 left-0 bg-primary"
                initial={{ width: "0%" }}
                animate={{ 
                  width: step < currentStep ? "100%" : "0%" 
                }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}