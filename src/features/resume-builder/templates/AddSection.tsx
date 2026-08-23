import { useState } from 'react';
import { Plus, FileText, List, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomSection } from '@/types/resume';

interface AddSectionProps {
  onAddSection: (section: CustomSection) => void;
  className?: string;
}

const SECTION_TEMPLATES = [
  { type: 'text' as const, label: 'Text Section', icon: FileText, description: 'Free-form text content' },
  { type: 'list' as const, label: 'List Section', icon: List, description: 'Bullet points or items' },
  { type: 'entries' as const, label: 'Entry Section', icon: Layers, description: 'Multiple entries (like projects)' },
];

export function AddSection({ onAddSection, className }: AddSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [selectedType, setSelectedType] = useState<'text' | 'list' | 'entries'>('text');

  const handleAdd = () => {
    if (!title.trim()) return;
    
    const newSection: CustomSection = {
      id: `custom-${Date.now()}`,
      title: title.trim(),
      content: '',
      type: selectedType,
      entries: selectedType === 'entries' ? [] : undefined,
    };
    
    onAddSection(newSection);
    setTitle('');
    setIsOpen(false);
  };

  return (
    <div className={cn('relative', className)}>
      {!isOpen ? (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="w-full py-4 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50/50 transition-all flex items-center justify-center gap-2"
        >
          <Plus className="w-5 h-5" />
          Add New Section
        </button>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Add Custom Section</h3>
          
          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">Section Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Projects, Certifications, Awards..."
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>

          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-2">Section Type</label>
            <div className="grid grid-cols-3 gap-2">
              {SECTION_TEMPLATES.map(({ type, label, icon: Icon }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSelectedType(type)}
                  className={cn(
                    'p-2 rounded-lg border text-center transition-all',
                    selectedType === type
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 hover:border-gray-300 text-gray-600'
                  )}
                >
                  <Icon className="w-5 h-5 mx-auto mb-1" />
                  <span className="text-xs">{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex-1 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!title.trim()}
              className="flex-1 px-3 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add Section
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
