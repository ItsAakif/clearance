"use client";

import { motion, HTMLMotionProps } from "framer-motion";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { forwardRef, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const animatedButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border-2 border-border bg-card text-foreground hover:bg-secondary hover:border-primary/40",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        hero: "bg-primary text-primary-foreground shadow-lg hover:shadow-xl",
        accent: "bg-accent text-accent-foreground hover:bg-accent-emphasis/40",
      },
      size: {
        default: "h-10 px-5 py-2",
        sm: "h-9 rounded-lg px-4 text-sm",
        lg: "h-12 rounded-xl px-8 text-base",
        xl: "h-14 rounded-2xl px-10 text-base font-semibold",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

interface AnimatedButtonProps
  extends VariantProps<typeof animatedButtonVariants> {
  hoverScale?: number;
  tapScale?: number;
  glowOnHover?: boolean;
  asChild?: boolean;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
}

const AnimatedButton = forwardRef<HTMLButtonElement, AnimatedButtonProps>(
  ({ 
    children, 
    hoverScale = 1.02, 
    tapScale = 0.98, 
    glowOnHover = false, 
    className,
    variant,
    size,
    asChild = false,
    onClick,
    disabled,
  }, ref) => {
    const animationProps = {
      whileHover: { 
        scale: hoverScale,
        y: -2,
        boxShadow: glowOnHover 
          ? "0 8px 30px hsl(var(--primary) / 0.35)" 
          : "0 10px 35px hsl(var(--foreground) / 0.08)"
      },
      whileTap: { scale: tapScale },
      transition: { 
        type: "spring" as const, 
        stiffness: 400, 
        damping: 20 
      },
    };

    if (asChild) {
      return (
        <motion.div
          {...animationProps}
          className="inline-block"
        >
          <Slot className={cn(animatedButtonVariants({ variant, size, className }))}>
            {children}
          </Slot>
        </motion.div>
      );
    }

    return (
      <motion.button
        ref={ref}
        onClick={onClick}
        disabled={disabled}
        {...animationProps}
        className={cn(animatedButtonVariants({ variant, size, className }))}
      >
        {children}
      </motion.button>
    );
  }
);

AnimatedButton.displayName = "AnimatedButton";

export default AnimatedButton;