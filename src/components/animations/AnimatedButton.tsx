import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import { forwardRef, ReactNode } from "react";
import { type VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button";

interface AnimatedButtonProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    // Omitted: framer-motion's MotionProps redefined these with (event, info)
    // signatures that clashed with the DOM handler types. Kept omitted so the
    // public prop surface does not change.
    "onAnimationStart" | "onDragStart" | "onDrag" | "onDragEnd"
  >,
    VariantProps<typeof buttonVariants> {
  /** Kept for API compatibility. Motion is colour/opacity only now. */
  hoverScale?: number;
  /** Kept for API compatibility. */
  tapScale?: number;
  /** Kept for API compatibility. There is no glow in this system. */
  glowOnHover?: boolean;
  asChild?: boolean;
  children?: ReactNode;
}

/**
 * A button that used to lift, scale and glow on hover. Those effects are gone:
 * the variant's background and border transition is the whole interaction.
 */
const AnimatedButton = forwardRef<HTMLButtonElement, AnimatedButtonProps>(
  ({ children, hoverScale: _hoverScale, tapScale: _tapScale, glowOnHover: _glowOnHover, className, variant, size, asChild = false, ...rest }, ref) => {
    if (asChild) {
      return (
        <Slot className={cn(buttonVariants({ variant, size, className }))} {...rest}>
          {children}
        </Slot>
      );
    }

    return (
      <Button ref={ref} variant={variant} size={size} className={className} {...rest}>
        {children}
      </Button>
    );
  }
);

AnimatedButton.displayName = "AnimatedButton";

export default AnimatedButton;
