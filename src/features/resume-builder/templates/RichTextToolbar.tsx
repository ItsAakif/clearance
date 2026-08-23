import { useState, useEffect, useCallback, useRef } from 'react';
import { Bold, Italic, Underline, Type, Palette } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RichTextToolbarProps {
  containerRef: React.RefObject<HTMLElement>;
}

const FONT_SIZES = ['10px', '12px', '14px', '16px', '18px', '20px', '24px'];
const COLORS = [
  '#000000', '#374151', '#6b7280', '#1e40af', '#047857', 
  '#b91c1c', '#7c3aed', '#c2410c', '#0369a1', '#4338ca'
];

export function RichTextToolbar({ containerRef }: RichTextToolbarProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [showFontSize, setShowFontSize] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      setIsVisible(false);
      return;
    }

    const range = selection.getRangeAt(0);
    const container = containerRef.current;
    
    if (!container || !container.contains(range.commonAncestorContainer)) {
      setIsVisible(false);
      return;
    }

    const rect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    
    setPosition({
      top: rect.top - containerRect.top - 45,
      left: rect.left - containerRect.left + (rect.width / 2) - 100,
    });
    setIsVisible(true);
  }, [containerRef]);

  useEffect(() => {
    const handleSelectionChange = () => {
      setTimeout(updatePosition, 10);
    };

    const handleMouseUp = () => {
      setTimeout(updatePosition, 10);
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [updatePosition]);

  const execCommand = useCallback((command: string, value?: string) => {
    document.execCommand(command, false, value);
    setShowFontSize(false);
    setShowColorPicker(false);
  }, []);

  const handleBold = () => execCommand('bold');
  const handleItalic = () => execCommand('italic');
  const handleUnderline = () => execCommand('underline');
  const handleFontSize = (size: string) => execCommand('fontSize', '7');
  const handleColor = (color: string) => execCommand('foreColor', color);

  if (!isVisible) return null;

  return (
    <div
      ref={toolbarRef}
      className={cn(
        'absolute z-50 flex items-center gap-1 p-1.5 bg-white rounded-lg shadow-xl border border-gray-200',
        'animate-in fade-in-0 zoom-in-95 duration-150'
      )}
      style={{ 
        top: Math.max(0, position.top), 
        left: Math.max(0, position.left),
        minWidth: '200px'
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={handleBold}
        className="p-1.5 rounded hover:bg-gray-100 transition-colors"
        title="Bold (Ctrl+B)"
      >
        <Bold className="w-4 h-4" />
      </button>
      
      <button
        type="button"
        onClick={handleItalic}
        className="p-1.5 rounded hover:bg-gray-100 transition-colors"
        title="Italic (Ctrl+I)"
      >
        <Italic className="w-4 h-4" />
      </button>
      
      <button
        type="button"
        onClick={handleUnderline}
        className="p-1.5 rounded hover:bg-gray-100 transition-colors"
        title="Underline (Ctrl+U)"
      >
        <Underline className="w-4 h-4" />
      </button>

      <div className="w-px h-5 bg-gray-200 mx-1" />

      <div className="relative">
        <button
          type="button"
          onClick={() => { setShowFontSize(!showFontSize); setShowColorPicker(false); }}
          className={cn(
            'p-1.5 rounded hover:bg-gray-100 transition-colors flex items-center gap-1',
            showFontSize && 'bg-gray-100'
          )}
          title="Font Size"
        >
          <Type className="w-4 h-4" />
        </button>
        {showFontSize && (
          <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 p-1 min-w-[80px]">
            {FONT_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => handleFontSize(size)}
                className="block w-full text-left px-2 py-1 text-sm hover:bg-gray-100 rounded"
              >
                {size}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => { setShowColorPicker(!showColorPicker); setShowFontSize(false); }}
          className={cn(
            'p-1.5 rounded hover:bg-gray-100 transition-colors',
            showColorPicker && 'bg-gray-100'
          )}
          title="Text Color"
        >
          <Palette className="w-4 h-4" />
        </button>
        {showColorPicker && (
          <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 p-2">
            <div className="grid grid-cols-5 gap-1">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => handleColor(color)}
                  className="w-6 h-6 rounded border border-gray-200 hover:scale-110 transition-transform"
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
