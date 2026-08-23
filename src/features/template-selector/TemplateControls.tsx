import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { TemplateSettings } from "@/types/template";

interface TemplateControlsProps {
  settings: TemplateSettings;
  onUpdateSetting: <K extends keyof TemplateSettings>(
    key: K,
    value: TemplateSettings[K]
  ) => void;
  onReset: () => void;
}

export function TemplateControls({
  settings,
  onUpdateSetting,
  onReset,
}: TemplateControlsProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Layout Controls</h3>
        <Button variant="ghost" size="sm" onClick={onReset} className="h-7 text-xs">
          <RotateCcw className="mr-1.5 h-3 w-3" />
          Reset
        </Button>
      </div>

      <div className="space-y-4">
        {/* Horizontal Margin */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Horizontal Margin</Label>
            <span className="text-xs text-muted-foreground">{settings.marginX}"</span>
          </div>
          <Slider
            value={[settings.marginX]}
            onValueChange={([v]) => onUpdateSetting("marginX", v)}
            min={0.5}
            max={1.5}
            step={0.05}
            className="w-full"
          />
        </div>

        {/* Vertical Margin */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Vertical Margin</Label>
            <span className="text-xs text-muted-foreground">{settings.marginY}"</span>
          </div>
          <Slider
            value={[settings.marginY]}
            onValueChange={([v]) => onUpdateSetting("marginY", v)}
            min={0.5}
            max={1.5}
            step={0.05}
            className="w-full"
          />
        </div>

        {/* Font Size */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Font Size</Label>
            <span className="text-xs text-muted-foreground">{settings.fontSize}pt</span>
          </div>
          <Slider
            value={[settings.fontSize]}
            onValueChange={([v]) => onUpdateSetting("fontSize", v)}
            min={9}
            max={14}
            step={0.5}
            className="w-full"
          />
        </div>

        {/* Line Spacing */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Line Spacing</Label>
            <span className="text-xs text-muted-foreground">{settings.lineSpacing.toFixed(2)}</span>
          </div>
          <Slider
            value={[settings.lineSpacing]}
            onValueChange={([v]) => onUpdateSetting("lineSpacing", v)}
            min={1.1}
            max={1.8}
            step={0.05}
            className="w-full"
          />
        </div>

        {/* Section Spacing */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Section Spacing</Label>
            <span className="text-xs text-muted-foreground">{settings.sectionSpacing.toFixed(1)}x</span>
          </div>
          <Slider
            value={[settings.sectionSpacing]}
            onValueChange={([v]) => onUpdateSetting("sectionSpacing", v)}
            min={1}
            max={3}
            step={0.25}
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
}
