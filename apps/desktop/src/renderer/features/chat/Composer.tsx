import { KeyboardEvent, useCallback, useRef, useState } from 'react';

type ComposerProps = {
  onSend: (content: string) => Promise<void>;
  onCancel: () => Promise<void>;
  streaming: boolean;
};

export const Composer = ({ onSend, onCancel, streaming }: ComposerProps) => {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const send = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    void onSend(trimmed).finally(() => {
      textareaRef.current?.focus();
    });
  };

  const cancel = async () => {
    if (!streaming) return;
    await onCancel();
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (value.trim()) {
        void send();
      } else if (streaming) {
        void cancel();
      }
    }
  };

  return (
    <div className="border-t border-border/40 px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-lg border border-border/60 bg-card/50 px-3 py-2 focus-within:border-border focus-within:ring-1 focus-within:ring-ring/30">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              resize();
            }}
            onKeyDown={onKeyDown}
            placeholder="Message OpenVibez..."
            rows={1}
            className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void (value.trim() ? send() : cancel())}
            disabled={!streaming && !value.trim()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-30"
          >
            {!value.trim() && streaming ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="3" y="3" width="8" height="8" rx="1.2" fill="currentColor" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 12V2M7 2l-4 4M7 2l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
          {streaming ? `${'\u2318'}+Enter to cancel` : `${'\u2318'}+Enter to send`}
        </p>
      </div>
    </div>
  );
};
