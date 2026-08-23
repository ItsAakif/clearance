import { TemplateCustomization, FontFamily, FontSize, SpacingSize, SpacingSettings, defaultCustomization, defaultSpacing } from './types';
import { RotateCcw } from 'lucide-react';

interface TemplateCustomizerProps {
  customization: TemplateCustomization;
  onChange: (customization: Partial<TemplateCustomization>) => void;
}

const fontOptions: { value: FontFamily; label: string }[] = [
  { value: 'inter', label: 'Inter' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'playfair', label: 'Playfair Display' },
  { value: 'montserrat', label: 'Montserrat' },
  { value: 'lato', label: 'Lato' },
  { value: 'merriweather', label: 'Merriweather' },
];

const fontSizeOptions: { value: FontSize; label: string }[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
];

const headingStyleOptions = [
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'normal', label: 'Normal' },
  { value: 'capitalize', label: 'Capitalize' },
];

const spacingOptions: { value: SpacingSize; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'tight', label: 'Tight' },
  { value: 'normal', label: 'Normal' },
  { value: 'relaxed', label: 'Relaxed' },
  { value: 'loose', label: 'Loose' },
];

interface SpacingControlProps {
  label: string;
  value: SpacingSize;
  onChange: (value: SpacingSize) => void;
}

function SpacingControl({ label, value, onChange }: SpacingControlProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex gap-0.5">
        {spacingOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            title={opt.label}
            className={`w-6 h-6 text-[10px] font-medium rounded transition-colors ${
              value === opt.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary/50 text-muted-foreground hover:bg-secondary'
            }`}
          >
            {opt.label[0]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TemplateCustomizer({ customization, onChange }: TemplateCustomizerProps) {
  const spacing = customization.layout?.spacing || defaultSpacing;

  const handleReset = () => {
    onChange(defaultCustomization);
  };

  const handleSpacingChange = (key: keyof SpacingSettings, value: SpacingSize) => {
    onChange({
      layout: {
        ...customization.layout,
        spacing: {
          ...spacing,
          [key]: value,
        },
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Customize</h3>
        <button
          onClick={handleReset}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Reset
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-2">Primary Color</label>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded border border-border shrink-0"
              style={{ backgroundColor: customization.primaryColor }}
            />
            <input
              type="text"
              value={customization.primaryColor}
              onChange={(e) => onChange({ primaryColor: e.target.value })}
              className="flex-1 px-2 py-1.5 text-sm border border-border rounded bg-background"
              placeholder="#1e293b"
            />
            <input
              type="color"
              value={customization.primaryColor}
              onChange={(e) => onChange({ primaryColor: e.target.value })}
              className="w-8 h-8 rounded cursor-pointer"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-2">Secondary Color</label>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded border border-border shrink-0"
              style={{ backgroundColor: customization.secondaryColor }}
            />
            <input
              type="text"
              value={customization.secondaryColor}
              onChange={(e) => onChange({ secondaryColor: e.target.value })}
              className="flex-1 px-2 py-1.5 text-sm border border-border rounded bg-background"
              placeholder="#3b82f6"
            />
            <input
              type="color"
              value={customization.secondaryColor}
              onChange={(e) => onChange({ secondaryColor: e.target.value })}
              className="w-8 h-8 rounded cursor-pointer"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-2">Font Family</label>
          <select
            value={customization.fontFamily}
            onChange={(e) => onChange({ fontFamily: e.target.value as FontFamily })}
            className="w-full px-2 py-1.5 text-sm border border-border rounded bg-background"
          >
            {fontOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-2">Font Size</label>
          <div className="flex gap-1">
            {fontSizeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onChange({ fontSize: opt.value })}
                className={`flex-1 py-1.5 text-sm font-medium rounded transition-colors ${
                  customization.fontSize === opt.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-2">Heading Style</label>
          <select
            value={customization.headingStyle}
            onChange={(e) => onChange({ headingStyle: e.target.value as 'uppercase' | 'normal' | 'capitalize' })}
            className="w-full px-2 py-1.5 text-sm border border-border rounded bg-background"
          >
            {headingStyleOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="pt-2 border-t border-border">
          <label className="block text-xs font-medium text-foreground mb-3">Spacing Controls</label>
          <div className="space-y-2">
            <SpacingControl
              label="Section Gap"
              value={spacing.sectionGap}
              onChange={(v) => handleSpacingChange('sectionGap', v)}
            />
            <SpacingControl
              label="Item Gap"
              value={spacing.itemGap}
              onChange={(v) => handleSpacingChange('itemGap', v)}
            />
            <SpacingControl
              label="Line Height"
              value={spacing.lineHeight}
              onChange={(v) => handleSpacingChange('lineHeight', v)}
            />
            <SpacingControl
              label="Page Padding"
              value={spacing.pagePadding}
              onChange={(v) => handleSpacingChange('pagePadding', v)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
