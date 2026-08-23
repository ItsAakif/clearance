"use client";

import { useEffect, useRef, useState } from 'react';

interface InteractiveDotGridProps {
  dotSpacing?: number;
  dotBaseSize?: number;
  influenceRadius?: number;
  maxScale?: number;
  showGrid?: boolean;
  numLayers?: number;
  hiddots?: boolean;
  className?: string;
}

const InteractiveDotGrid = ({
  dotSpacing = 32,
  dotBaseSize = 2,
  influenceRadius = 140,
  maxScale = 6,
  showGrid = true,
  numLayers = 2,
  hiddots = false,
  className,
}: InteractiveDotGridProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mousePos, setMousePos] = useState({ x: -1000, y: -1000 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get computed styles to read CSS variables
    const computedStyle = getComputedStyle(document.documentElement);
    const isDark = document.documentElement.classList.contains('dark');

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    window.addEventListener('resize', resize);

    const createDots = () => {
      const dots: { x: number; y: number; baseSize: number }[] = [];
      const rect = canvas.getBoundingClientRect();
      for (let x = dotSpacing; x < rect.width; x += dotSpacing) {
        for (let y = dotSpacing; y < rect.height; y += dotSpacing) {
          dots.push({ x, y, baseSize: dotBaseSize });
        }
      }
      return dots;
    };

    let dots = createDots();
    let animationId: number;

    const animate = () => {
      if (!ctx || !canvas) return;

      const rect = canvas.getBoundingClientRect();
      const isDarkNow = document.documentElement.classList.contains('dark');
      
      // Using new palette: Pine Blue for light, Dry Sage tint for dark
      const baseColor = isDarkNow ? 'rgba(210, 204, 161, 0.12)' : 'rgba(56, 119, 128, 0.12)';
      const hoverColor = isDarkNow ? 'rgba(210, 204, 161, 0.5)' : 'rgba(56, 119, 128, 0.45)';
      
      // Clear with transparent background
      ctx.clearRect(0, 0, rect.width, rect.height);

      dots.forEach((dot) => {
        const dx = mousePos.x - dot.x;
        const dy = mousePos.y - dot.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (hiddots && distance >= influenceRadius) {
          return;
        }

        let scale = 1;

        if (distance < influenceRadius && showGrid) {
          const influence = 1 - distance / influenceRadius;
          scale = 1 + influence * influence * (maxScale - 1);
        }

        const size = dot.baseSize * scale;

        // Create gradient for hovered dots
        if (scale > 1.3) {
          const gradient = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, size * numLayers);
          gradient.addColorStop(0, hoverColor);
          gradient.addColorStop(1, 'transparent');
          ctx.fillStyle = gradient;
        } else {
          ctx.fillStyle = baseColor;
        }

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, size, 0, Math.PI * 2);
        ctx.fill();
      });

      animationId = requestAnimationFrame(animate);
    };

    animate();

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      setMousePos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    };

    const handleMouseLeave = () => {
      setMousePos({ x: -1000, y: -1000 });
    };

    const handleResize = () => {
      resize();
      dots = createDots();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('resize', handleResize);

    // Watch for theme changes
    const observer = new MutationObserver(() => {
      // Theme changed, dots will update on next frame
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      cancelAnimationFrame(animationId);
    };
  }, [mousePos, dotSpacing, dotBaseSize, influenceRadius, maxScale, showGrid, numLayers, hiddots]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
};

export default InteractiveDotGrid;