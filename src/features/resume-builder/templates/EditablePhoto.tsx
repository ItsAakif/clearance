import { useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Camera, User, X, Minus, Plus } from 'lucide-react';

interface EditablePhotoProps {
  photoUrl?: string;
  onPhotoChange?: (url: string) => void;
  onPhotoUpload?: (file: File) => Promise<string>;
  size?: 'small' | 'medium' | 'large' | 'xlarge';
  onSizeChange?: (size: 'small' | 'medium' | 'large' | 'xlarge') => void;
  shape?: 'circle' | 'square' | 'rounded';
  editable?: boolean;
  resizable?: boolean;
  className?: string;
  placeholderClassName?: string;
}

const sizeClasses = {
  small: 'w-16 h-16',
  medium: 'w-24 h-24',
  large: 'w-32 h-32',
  xlarge: 'w-40 h-40',
};

const sizeOrder: ('small' | 'medium' | 'large' | 'xlarge')[] = ['small', 'medium', 'large', 'xlarge'];

const shapeClasses = {
  circle: 'rounded-full',
  square: 'rounded-none',
  rounded: 'rounded-xl',
};

export function EditablePhoto({
  photoUrl,
  onPhotoChange,
  onPhotoUpload,
  size = 'medium',
  onSizeChange,
  shape = 'circle',
  editable = true,
  resizable = false,
  className,
  placeholderClassName,
}: EditablePhotoProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [showSizeControls, setShowSizeControls] = useState(false);

  const displayUrl = localPreview || photoUrl;
  const currentSizeIndex = sizeOrder.indexOf(size);

  const handleSizeDecrease = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentSizeIndex > 0 && onSizeChange) {
      onSizeChange(sizeOrder[currentSizeIndex - 1]);
    }
  }, [currentSizeIndex, onSizeChange]);

  const handleSizeIncrease = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (currentSizeIndex < sizeOrder.length - 1 && onSizeChange) {
      onSizeChange(sizeOrder[currentSizeIndex + 1]);
    }
  }, [currentSizeIndex, onSizeChange]);

  const handleClick = useCallback(() => {
    if (editable && inputRef.current) {
      inputRef.current.click();
    }
  }, [editable]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert('Image must be less than 5MB');
      return;
    }

    setIsLoading(true);

    try {
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target?.result as string;
        setLocalPreview(dataUrl);
        
        if (onPhotoUpload) {
          onPhotoUpload(file).then((url) => {
            onPhotoChange?.(url);
            setLocalPreview(null);
          }).catch((err) => {
            console.error('Photo upload failed:', err);
          });
        } else {
          onPhotoChange?.(dataUrl);
        }
      };
      reader.readAsDataURL(file);
    } finally {
      setIsLoading(false);
    }
  }, [onPhotoChange, onPhotoUpload]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setLocalPreview(null);
    onPhotoChange?.('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, [onPhotoChange]);

  return (
    <div 
      className="relative inline-block"
      onMouseEnter={() => resizable && editable && setShowSizeControls(true)}
      onMouseLeave={() => setShowSizeControls(false)}
    >
      <div
        className={cn(
          'relative group overflow-hidden bg-gray-200 flex items-center justify-center cursor-pointer transition-all',
          sizeClasses[size],
          shapeClasses[shape],
          editable && 'hover:ring-2 hover:ring-primary hover:ring-offset-2',
          className
        )}
        onClick={handleClick}
      >
        {displayUrl ? (
          <>
            <img
              src={displayUrl}
              alt="Profile"
              className={cn('w-full h-full object-cover', shapeClasses[shape])}
            />
            {editable && (
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Camera className="w-6 h-6 text-white" />
              </div>
            )}
            {editable && displayUrl && (
              <button
                type="button"
                onClick={handleRemove}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </>
        ) : (
          <div className={cn('flex flex-col items-center justify-center text-gray-400', placeholderClassName)}>
            <User className={cn(size === 'small' ? 'w-6 h-6' : size === 'medium' ? 'w-10 h-10' : 'w-14 h-14')} />
            {editable && size !== 'small' && (
              <span className="text-xs mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                Add Photo
              </span>
            )}
          </div>
        )}

        {isLoading && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {resizable && editable && showSizeControls && (
        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-white rounded-full shadow-lg border border-gray-200 p-1">
          <button
            type="button"
            onClick={handleSizeDecrease}
            disabled={currentSizeIndex === 0}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="text-xs text-gray-500 w-12 text-center">{size}</span>
          <button
            type="button"
            onClick={handleSizeIncrease}
            disabled={currentSizeIndex === sizeOrder.length - 1}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}
