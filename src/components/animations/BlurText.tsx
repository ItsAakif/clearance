"use client";

import { useRef, useEffect, useState } from "react";
import { motion, useInView, Variants } from "framer-motion";

interface BlurTextProps {
  text: string;
  className?: string;
  animateBy?: "words" | "letters";
  direction?: "top" | "bottom";
  delay?: number;
  stepDuration?: number;
  threshold?: number;
  as?: "h1" | "h2" | "h3" | "h4" | "p" | "span";
}

export default function BlurText({
  text,
  className = "",
  animateBy = "words",
  direction = "top",
  delay = 80,
  stepDuration = 0.35,
  threshold = 0.1,
  as: Tag = "p",
}: BlurTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, amount: threshold });
  const [hasAnimated, setHasAnimated] = useState(false);

  useEffect(() => {
    if (isInView && !hasAnimated) {
      setHasAnimated(true);
    }
  }, [isInView, hasAnimated]);

  const elements = animateBy === "words" ? text.split(" ") : text.split("");

  const containerVariants: Variants = {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: delay / 1000,
      },
    },
  };

  const childVariants: Variants = {
    hidden: {
      opacity: 0,
      filter: "blur(10px)",
      y: direction === "top" ? -20 : 20,
    },
    visible: {
      opacity: 1,
      filter: "blur(0px)",
      y: 0,
      transition: {
        duration: stepDuration,
        ease: "easeOut",
      },
    },
  };

  return (
    <motion.div
      ref={ref}
      variants={containerVariants}
      initial="hidden"
      animate={hasAnimated ? "visible" : "hidden"}
      className={className}
    >
      <Tag className="inline">
        {elements.map((element, index) => (
          <motion.span
            key={index}
            variants={childVariants}
            className="inline-block"
            style={{ marginRight: animateBy === "words" ? "0.3em" : "0" }}
          >
            {element}
          </motion.span>
        ))}
      </Tag>
    </motion.div>
  );
}