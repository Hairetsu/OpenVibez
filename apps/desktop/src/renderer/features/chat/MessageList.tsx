import { useEffect, useRef } from 'react';
import type { Message, MessageStreamTrace } from '../../../preload/types';
import { cn } from '@/lib/utils';

type MessageListProps = {
  messages: Message[];
  liveText?: string;
  streaming?: boolean;
  traces?: MessageStreamTrace[];
};

export const MessageList = ({ messages, liveText, streaming, traces = [] }: MessageListProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, liveText]);

  if (messages.length === 0 && !liveText) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">No messages yet</p>
          <p className="mt-1 text-xs text-muted-foreground/60">Send a prompt to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="scroll-soft flex-1 overflow-auto">
      <div className="mx-auto max-w-3xl px-4 py-4">
        <div className="grid gap-5">
          {messages.map((message) => (
            <div key={message.id} className="group">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={cn(
                    'text-[11px] font-medium uppercase tracking-wide',
                    message.role === 'user' ? 'text-foreground/50' : 'text-primary/70'
                  )}
                >
                  {message.role}
                </span>
              </div>
              <div
                className={cn(
                  'rounded-lg px-3 py-2.5 text-[13px] leading-relaxed',
                  message.role === 'user'
                    ? 'bg-muted/40 text-foreground'
                    : 'text-foreground/90'
                )}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
              </div>
            </div>
          ))}

          {traces.map((trace, index) => (
            <div key={`${trace.traceKind}-${index}`} className="group">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-accent-foreground/70">
                  {trace.traceKind}
                </span>
                {streaming && (
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent-foreground/40" />
                )}
              </div>
              <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-[12px] leading-relaxed text-foreground/85">
                <p className="whitespace-pre-wrap">{trace.text}</p>
              </div>
            </div>
          ))}

          {liveText && streaming && (
            <div className="group">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-primary/70">
                  assistant
                </span>
                {streaming && (
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                )}
              </div>
              <div className="text-[13px] leading-relaxed text-foreground/90">
                <p className="whitespace-pre-wrap">{liveText}</p>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
};
