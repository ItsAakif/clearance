import { useState, useRef, useCallback, ReactNode, useEffect } from 'react';
import { GripVertical, GripHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ResizableSidebarProps {
  children: ReactNode;
  sidebarContent: ReactNode;
  sidebarPosition: 'left' | 'right';
  initialWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  onWidthChange?: (width: number) => void;
  editable?: boolean;
  sidebarClassName?: string;
  mainClassName?: string;
}

export function ResizableSidebar({
  children,
  sidebarContent,
  sidebarPosition,
  initialWidth = 280,
  minWidth = 180,
  maxWidth = 400,
  onWidthChange,
  editable = true,
  sidebarClassName = '',
  mainClassName = '',
}: ResizableSidebarProps) {
  const [width, setWidth] = useState(initialWidth);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setWidth(initialWidth);
  }, [initialWidth]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = width;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = sidebarPosition === 'left' 
        ? e.clientX - startX 
        : startX - e.clientX;
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
      setWidth(newWidth);
      onWidthChange?.(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [editable, width, sidebarPosition, minWidth, maxWidth, onWidthChange]);

  const resizeHandle = editable && (
    <div
      className={cn(
        'absolute top-0 h-full w-4 cursor-col-resize z-30 flex items-center justify-center group',
        sidebarPosition === 'left' ? '-right-2' : '-left-2',
        isDragging && 'bg-blue-500/10'
      )}
      onMouseDown={handleMouseDown}
      style={{ touchAction: 'none' }}
    >
      <div className={cn(
        'w-1 h-16 rounded-full transition-all opacity-0 group-hover:opacity-100',
        isDragging ? 'bg-blue-500 opacity-100' : 'bg-blue-400'
      )}>
        <GripVertical className="w-4 h-4 text-white absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="flex w-full min-h-[11in]">
      {sidebarPosition === 'left' ? (
        <>
          <aside 
            className={cn('shrink-0 relative', sidebarClassName)}
            style={{ width: `${width}px` }}
          >
            {sidebarContent}
            {resizeHandle}
          </aside>
          <main className={cn('flex-1 min-w-0', mainClassName)}>
            {children}
          </main>
        </>
      ) : (
        <>
          <main className={cn('flex-1 min-w-0', mainClassName)}>
            {children}
          </main>
          <aside 
            className={cn('shrink-0 relative', sidebarClassName)}
            style={{ width: `${width}px` }}
          >
            {resizeHandle}
            {sidebarContent}
          </aside>
        </>
      )}
    </div>
  );
}

interface ResizableHeaderProps {
  children: ReactNode;
  headerContent: ReactNode;
  initialHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  onHeightChange?: (height: number) => void;
  editable?: boolean;
  headerClassName?: string;
  mainClassName?: string;
}

export function ResizableHeader({
  children,
  headerContent,
  initialHeight = 200,
  minHeight = 100,
  maxHeight = 350,
  onHeightChange,
  editable = true,
  headerClassName = '',
  mainClassName = '',
}: ResizableHeaderProps) {
  const [height, setHeight] = useState(initialHeight);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    setHeight(initialHeight);
  }, [initialHeight]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);

    const startY = e.clientY;
    const startHeight = height;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + delta));
      setHeight(newHeight);
      onHeightChange?.(newHeight);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [editable, height, minHeight, maxHeight, onHeightChange]);

  return (
    <div className="flex flex-col w-full min-h-[11in]">
      <header 
        className={cn('shrink-0 relative overflow-hidden', headerClassName)}
        style={{ height: `${height}px` }}
      >
        {headerContent}
        {editable && (
          <div
            className={cn(
              'absolute left-0 right-0 bottom-0 h-4 cursor-row-resize z-30 flex items-center justify-center group',
              isDragging && 'bg-blue-500/10'
            )}
            onMouseDown={handleMouseDown}
            style={{ touchAction: 'none' }}
          >
            <div className={cn(
              'w-16 h-1 rounded-full transition-all opacity-0 group-hover:opacity-100',
              isDragging ? 'bg-blue-500 opacity-100' : 'bg-blue-400'
            )}>
              <GripHorizontal className="w-4 h-4 text-white absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
            </div>
          </div>
        )}
      </header>
      <main className={cn('flex-1', mainClassName)}>
        {children}
      </main>
    </div>
  );
}

interface ResizableColumnsProps {
  leftContent: ReactNode;
  rightContent: ReactNode;
  initialRatio?: number;
  minRatio?: number;
  maxRatio?: number;
  onRatioChange?: (ratio: number) => void;
  editable?: boolean;
  leftClassName?: string;
  rightClassName?: string;
}

export function ResizableColumns({
  leftContent,
  rightContent,
  initialRatio = 50,
  minRatio = 30,
  maxRatio = 70,
  onRatioChange,
  editable = true,
  leftClassName = '',
  rightClassName = '',
}: ResizableColumnsProps) {
  const [ratio, setRatio] = useState(initialRatio);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRatio(initialRatio);
  }, [initialRatio]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!editable || !containerRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);

    const containerRect = containerRef.current.getBoundingClientRect();

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const relativeX = e.clientX - containerRect.left;
      const newRatio = Math.max(minRatio, Math.min(maxRatio, (relativeX / containerRect.width) * 100));
      setRatio(newRatio);
      onRatioChange?.(newRatio);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [editable, minRatio, maxRatio, onRatioChange]);

  return (
    <div ref={containerRef} className="flex w-full min-h-[11in] relative">
      <div 
        className={cn('shrink-0 min-h-full', leftClassName)}
        style={{ width: `${ratio}%` }}
      >
        {leftContent}
      </div>
      {editable && (
        <div
          className={cn(
            'absolute top-0 h-full w-4 cursor-col-resize z-30 flex items-center justify-center group',
            isDragging && 'bg-blue-500/10'
          )}
          style={{ left: `${ratio}%`, transform: 'translateX(-50%)', touchAction: 'none' }}
          onMouseDown={handleMouseDown}
        >
          <div className={cn(
            'w-1 h-16 rounded-full transition-all opacity-0 group-hover:opacity-100',
            isDragging ? 'bg-blue-500 opacity-100' : 'bg-blue-400'
          )}>
            <GripVertical className="w-4 h-4 text-white absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
          </div>
        </div>
      )}
      <div 
        className={cn('flex-1 min-w-0 min-h-full', rightClassName)}
      >
        {rightContent}
      </div>
    </div>
  );
}
