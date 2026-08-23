import { ReactNode, forwardRef, CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { TemplateCustomization, FontFamily, FontSize } from './types';

// Font family CSS values
const fontFamilyMap: Record<FontFamily, string> = {
  inter: "'Inter', 'Segoe UI', system-ui, sans-serif",
  roboto: "'Roboto', 'Helvetica Neue', Arial, sans-serif",
  playfair: "'Playfair Display', Georgia, serif",
  montserrat: "'Montserrat', 'Segoe UI', sans-serif",
  lato: "'Lato', 'Helvetica Neue', Arial, sans-serif",
  merriweather: "'Merriweather', Georgia, serif",
};

// Font size scale factors
const fontSizeScale: Record<FontSize, number> = {
  small: 0.9,
  medium: 1,
  large: 1.1,
};

interface ResumePageProps {
  children: ReactNode;
  className?: string;
  scale?: number;
  style?: CSSProperties;
  customization?: TemplateCustomization;
}

export const ResumePage = forwardRef<HTMLDivElement, ResumePageProps>(
  ({ children, className, scale = 1, style, customization }, ref) => {
    const fontFamily = customization?.fontFamily || 'inter';
    const fontSize = customization?.fontSize || 'medium';
    const sizeScale = fontSizeScale[fontSize];

    return (
      <div
        ref={ref}
        className={cn(
          'resume-page',
          'w-[8.5in] min-h-[11in] bg-white text-black',
          'mx-auto shadow-2xl',
          'print:shadow-none print:m-0',
          className
        )}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'top center',
          fontFamily: fontFamilyMap[fontFamily],
          fontSize: `${sizeScale}em`,
          ...style,
        }}
      >
        {children}
      </div>
    );
  }
);

ResumePage.displayName = 'ResumePage';

interface SectionProps {
  title?: string;
  children: ReactNode;
  className?: string;
  showTitle?: boolean;
  titleStyle?: CSSProperties;
  style?: CSSProperties;
  titleMarginBottom?: string;
}

export function Section({ 
  title, 
  children, 
  className,
  showTitle = true,
  titleStyle,
  style,
  titleMarginBottom
}: SectionProps) {
  return (
    <section className={cn(className)} style={style}>
      {showTitle && title && (
        <h2 
          className="text-[11px] font-semibold uppercase tracking-wider text-gray-600 pb-1 border-b border-gray-300"
          style={{ marginBottom: titleMarginBottom || '0.5rem', ...titleStyle }}
        >
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

interface EntryHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  date?: ReactNode;
  location?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function EntryHeader({ 
  title, 
  subtitle, 
  date, 
  location,
  className,
  style
}: EntryHeaderProps) {
  return (
    <div className={cn('flex justify-between items-start gap-4', className)} style={style}>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold text-gray-900">{title}</div>
        {subtitle && (
          <div className="text-[14px] text-gray-600">{subtitle}</div>
        )}
      </div>
      {(date || location) && (
        <div className="text-right shrink-0">
          {date && (
            <div className="text-[13px] text-gray-500 whitespace-nowrap">{date}</div>
          )}
          {location && (
            <div className="text-[12px] text-gray-400">{location}</div>
          )}
        </div>
      )}
    </div>
  );
}

interface EntryGroupProps {
  children: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  editable?: boolean;
  className?: string;
}

export function EntryGroup({ 
  children, 
  onAdd, 
  addLabel = 'Add Entry',
  editable = true,
  className 
}: EntryGroupProps) {
  return (
    <div className={cn('group/entries', className)}>
      {children}
      {editable && onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="mt-3 w-full py-2 text-sm text-muted-foreground border border-dashed border-gray-300 hover:border-primary hover:text-primary rounded transition-colors opacity-0 group-hover/entries:opacity-100"
        >
          + {addLabel}
        </button>
      )}
    </div>
  );
}

interface EntryWrapperProps {
  children: ReactNode;
  onDelete?: () => void;
  editable?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function EntryWrapper({ 
  children, 
  onDelete,
  editable = true,
  className,
  style
}: EntryWrapperProps) {
  return (
    <div className={cn('group/entry relative', className)} style={style}>
      {children}
      {editable && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="absolute -right-2 top-0 w-5 h-5 flex items-center justify-center text-xs rounded border border-gray-200 bg-white text-gray-400 hover:text-destructive hover:border-destructive opacity-0 group-hover/entry:opacity-100 transition-all"
        >
          ×
        </button>
      )}
    </div>
  );
}
