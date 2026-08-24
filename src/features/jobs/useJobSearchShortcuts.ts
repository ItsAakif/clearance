import { useEffect, useRef, useCallback } from "react";

export interface UseJobSearchShortcutsOptions {
  enabled: boolean;
  hasSelection: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onSave: () => void;
  onOpen: () => void;
  onAnalyse: () => void;
}

export function useJobSearchShortcuts(options: UseJobSearchShortcutsOptions): void {
  const { enabled, hasSelection } = options;
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat) return;

      const target = e.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
        if (target.closest('[contenteditable="true"]')) return;
      }

      const key = e.key.toLowerCase();
      const opts = optsRef.current;
      switch (key) {
        case 'j':
          e.preventDefault();
          opts.onNext();
          break;
        case 'k':
          e.preventDefault();
          opts.onPrevious();
          break;
        case 's':
          if (opts.hasSelection) {
            e.preventDefault();
            opts.onSave();
          }
          break;
        case 'o':
          if (opts.hasSelection) {
            e.preventDefault();
            opts.onOpen();
          }
          break;
        case 'a':
          if (opts.hasSelection) {
            e.preventDefault();
            opts.onAnalyse();
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled]);
}
