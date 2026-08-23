import { useState, useRef, useEffect, ReactNode } from 'react';
import { Palette } from 'lucide-react';

interface InlineColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  children: ReactNode;
  colorType?: 'primary' | 'secondary';
  editable?: boolean;
  className?: string;
  as?: keyof JSX.IntrinsicElements;
}

const colorPresets = {
  primary: [
    '#1e293b', // Slate 800
    '#0f172a', // Slate 900
    '#18181b', // Zinc 900
    '#1f2937', // Gray 800
    '#292524', // Stone 800
    '#1e3a5f', // Navy
    '#134e4a', // Teal 900
    '#14532d', // Green 900
    '#581c87', // Purple 900
    '#7c2d12', // Orange 900
    '#991b1b', // Red 800
    '#3730a3', // Indigo 800
  ],
  secondary: [
    '#3b82f6', // Blue 500
    '#06b6d4', // Cyan 500
    '#14b8a6', // Teal 500
    '#10b981', // Emerald 500
    '#8b5cf6', // Violet 500
    '#ec4899', // Pink 500
    '#f43f5e', // Rose 500
    '#f97316', // Orange 500
    '#eab308', // Yellow 500
    '#22c55e', // Green 500
    '#6366f1', // Indigo 500
    '#64748b', // Slate 500
  ],
};

export function InlineColorPicker({
  color,
  onChange,
  children,
  colorType = 'primary',
  editable = true,
  className = '',
  as: Component = 'div',
}: InlineColorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customColor, setCustomColor] = useState(color);
  const pickerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowCustomInput(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    setCustomColor(color);
  }, [color]);

  const handleColorSelect = (newColor: string) => {
    onChange(newColor);
    setIsOpen(false);
    setShowCustomInput(false);
  };

  const handleCustomColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value;
    setCustomColor(newColor);
    onChange(newColor);
  };

  const presets = colorPresets[colorType];

  if (!editable) {
    return <>{children}</>;
  }

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      <div
        className="group relative cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
      >
        {children}
        <div className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <div
            className="w-5 h-5 rounded-full border-2 border-white shadow-lg flex items-center justify-center"
            style={{ backgroundColor: color }}
          >
            <Palette className="w-3 h-3 text-white drop-shadow" />
          </div>
        </div>
      </div>

      {isOpen && (
        <div
          ref={pickerRef}
          className="absolute z-50 mt-2 p-3 bg-white rounded-lg shadow-xl border border-gray-200 min-w-[200px]"
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="grid grid-cols-6 gap-1.5 mb-3">
            {presets.map((presetColor) => (
              <button
                key={presetColor}
                type="button"
                onClick={() => handleColorSelect(presetColor)}
                className={`w-7 h-7 rounded-md border-2 transition-all hover:scale-110 ${
                  color === presetColor
                    ? 'border-blue-500 ring-2 ring-blue-200'
                    : 'border-gray-200 hover:border-gray-400'
                }`}
                style={{ backgroundColor: presetColor }}
                title={presetColor}
              />
            ))}
          </div>

          <div className="border-t border-gray-100 pt-2">
            {showCustomInput ? (
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={customColor}
                  onChange={handleCustomColorChange}
                  className="w-8 h-8 rounded cursor-pointer border-0 p-0"
                />
                <input
                  type="text"
                  value={customColor}
                  onChange={(e) => {
                    setCustomColor(e.target.value);
                    if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) {
                      onChange(e.target.value);
                    }
                  }}
                  className="flex-1 px-2 py-1 text-xs border border-gray-200 rounded font-mono"
                  placeholder="#000000"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCustomInput(true)}
                className="w-full text-xs text-gray-500 hover:text-gray-700 py-1 transition-colors"
              >
                Custom color...
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ColorableHeaderProps {
  color: string;
  onChange: (color: string) => void;
  children: ReactNode;
  editable?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function ColorableHeader({
  color,
  onChange,
  children,
  editable = true,
  className = '',
  style = {},
}: ColorableHeaderProps) {
  return (
    <InlineColorPicker color={color} onChange={onChange} colorType="primary" editable={editable}>
      <div className={className} style={{ ...style, backgroundColor: color }}>
        {children}
      </div>
    </InlineColorPicker>
  );
}

export function ColorableSidebar({
  color,
  onChange,
  children,
  editable = true,
  className = '',
  style = {},
}: ColorableHeaderProps) {
  return (
    <InlineColorPicker color={color} onChange={onChange} colorType="primary" editable={editable}>
      <aside className={className} style={{ ...style, backgroundColor: color }}>
        {children}
      </aside>
    </InlineColorPicker>
  );
}

export function ColorableAccent({
  color,
  onChange,
  children,
  editable = true,
  className = '',
  style = {},
}: ColorableHeaderProps) {
  return (
    <InlineColorPicker color={color} onChange={onChange} colorType="secondary" editable={editable}>
      <div className={className} style={{ ...style, borderColor: color }}>
        {children}
      </div>
    </InlineColorPicker>
  );
}

export function ColorableText({
  color,
  onChange,
  children,
  editable = true,
  className = '',
  style = {},
}: ColorableHeaderProps) {
  return (
    <InlineColorPicker color={color} onChange={onChange} colorType="secondary" editable={editable}>
      <span className={className} style={{ ...style, color }}>
        {children}
      </span>
    </InlineColorPicker>
  );
}
