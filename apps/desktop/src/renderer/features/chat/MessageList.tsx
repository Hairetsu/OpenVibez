import { useEffect, useMemo, useRef } from 'react';
import type { Message, MessageStreamTrace } from '../../../preload/types';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import {
  BrainCircuit,
  CheckCircle2,
  Circle,
  FileCode2,
  ListChecks,
  Loader2,
  Sparkles,
  TerminalSquare
} from 'lucide-react';

type MessageListProps = {
  messages: Message[];
  liveText?: string;
  streaming?: boolean;
  traces?: MessageStreamTrace[];
  status?: string | null;
  statusTrail?: string[];
};

type TraceMeta = {
  label: string;
  icon: LucideIcon;
  accentClass: string;
  cardClass: string;
};

type ChecklistItem = {
  done: boolean;
  index: number;
  text: string;
};

type ParsedTrace =
  | {
      kind: 'checklist';
      items: ChecklistItem[];
      fileLocations: string[];
      changeSummary: string | null;
    }
  | {
      kind: 'command';
      step: number | null;
      command: string;
      cwd: string | null;
      fileLocations: string[];
      changeSummary: string | null;
    }
  | {
      kind: 'result';
      exit: string | null;
      timedOut: boolean;
      stdout: string | null;
      stderr: string | null;
      fileLocations: string[];
      changeSummary: string | null;
    }
  | {
      kind: 'note';
      text: string;
      fileLocations: string[];
      changeSummary: string | null;
    };

const TRACE_META: Record<MessageStreamTrace['traceKind'], TraceMeta> = {
  thought: {
    label: 'Thought',
    icon: BrainCircuit,
    accentClass: 'text-amber-300',
    cardClass: 'border-amber-300/30 bg-amber-300/10'
  },
  plan: {
    label: 'Plan',
    icon: ListChecks,
    accentClass: 'text-sky-300',
    cardClass: 'border-sky-300/30 bg-sky-300/10'
  },
  action: {
    label: 'Action',
    icon: TerminalSquare,
    accentClass: 'text-emerald-300',
    cardClass: 'border-emerald-300/30 bg-emerald-300/10'
  }
};

const CHECKLIST_LINE = /^\[(x| )\]\s+(\d+)\.\s+(.+)$/i;
const FILE_LOCATION_PATTERN =
  /(?:^|[\s`"'([{])((?:\/|\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?)/g;

const compactStatuses = (trail: string[], latest: string | null | undefined): string[] => {
  const base = trail.length > 0 ? trail : (latest ? [latest] : []);
  if (base.length === 0) {
    return [];
  }

  return base.filter((status, index) => status.trim() && (index === 0 || status !== base[index - 1]));
};

const extractFileLocations = (text: string): string[] => {
  const matches: string[] = [];
  for (const found of text.matchAll(FILE_LOCATION_PATTERN)) {
    const value = found[1]?.trim().replace(/[),.;]+$/, '');
    if (!value || /^https?:\/\//i.test(value)) {
      continue;
    }
    matches.push(value);
  }

  return [...new Set(matches)].slice(0, 8);
};

const extractChangeSummary = (text: string): string | null => {
  const gitSummary = text.match(
    /(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/i
  );
  if (gitSummary) {
    const files = Number(gitSummary[1]);
    const insertions = gitSummary[2] ? Number(gitSummary[2]) : 0;
    const deletions = gitSummary[3] ? Number(gitSummary[3]) : 0;
    const details = [`${files} file${files === 1 ? '' : 's'} changed`];
    if (insertions > 0) details.push(`+${insertions}`);
    if (deletions > 0) details.push(`-${deletions}`);
    return details.join(' ');
  }

  const patchOps = (text.match(/\*\*\*\s+(?:Add|Update|Delete)\s+File:/g) ?? []).length;
  if (patchOps > 0) {
    return `${patchOps} file${patchOps === 1 ? '' : 's'} changed`;
  }

  return null;
};

const parseChecklist = (text: string): ChecklistItem[] | null => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const parsed = lines.map((line) => {
    const match = line.match(CHECKLIST_LINE);
    if (!match) {
      return null;
    }

    return {
      done: match[1].toLowerCase() === 'x',
      index: Number(match[2]),
      text: match[3].trim()
    } satisfies ChecklistItem;
  });

  if (parsed.some((entry) => !entry)) {
    return null;
  }

  return parsed as ChecklistItem[];
};

const parseCommand = (text: string): { step: number | null; command: string; cwd: string | null } | null => {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) {
    return null;
  }

  const headerMatch = lines[0]?.trim().match(/^Step\s+(\d+)\s+command:\s*$/i);
  if (!headerMatch) {
    return null;
  }

  const cwdIndex = lines.findIndex((line, index) => index > 0 && /^cwd:\s*/i.test(line.trim()));
  const commandLines = lines
    .slice(1, cwdIndex === -1 ? undefined : cwdIndex)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (commandLines.length === 0) {
    return null;
  }

  const cwd = cwdIndex === -1 ? null : (lines[cwdIndex]?.trim().replace(/^cwd:\s*/i, '').trim() || null);

  return {
    step: Number(headerMatch[1]),
    command: commandLines.join('\n'),
    cwd
  };
};

const parseResult = (
  text: string
): { exit: string | null; timedOut: boolean; stdout: string | null; stderr: string | null } | null => {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^exit:\s*/i.test(firstLine)) {
    return null;
  }

  const exit = firstLine.replace(/^exit:\s*/i, '').trim() || null;
  const stdout = text.match(/(?:^|\n)stdout:\n([\s\S]*?)(?=\n(?:stderr:|$))/i)?.[1]?.trim() ?? null;
  const stderr = text.match(/(?:^|\n)stderr:\n([\s\S]*)$/i)?.[1]?.trim() ?? null;

  return {
    exit,
    timedOut: /\(timeout\)/i.test(firstLine),
    stdout,
    stderr
  };
};

const parseTrace = (trace: MessageStreamTrace): ParsedTrace => {
  const text = trace.text.trim();
  const fileLocations = extractFileLocations(text);
  const changeSummary = extractChangeSummary(text);

  const checklist = parseChecklist(text);
  if (checklist) {
    return {
      kind: 'checklist',
      items: checklist,
      fileLocations,
      changeSummary
    };
  }

  const command = parseCommand(text);
  if (command) {
    return {
      kind: 'command',
      step: command.step,
      command: command.command,
      cwd: command.cwd,
      fileLocations,
      changeSummary
    };
  }

  const result = parseResult(text);
  if (result) {
    return {
      kind: 'result',
      exit: result.exit,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      fileLocations,
      changeSummary
    };
  }

  return {
    kind: 'note',
    text,
    fileLocations,
    changeSummary
  };
};

const roleLabel = (role: Message['role']): string => {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  if (role === 'tool') return 'Tool';
  return 'System';
};

export const MessageList = ({
  messages,
  liveText,
  streaming,
  traces = [],
  status,
  statusTrail = []
}: MessageListProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const statuses = useMemo(() => compactStatuses(statusTrail, status), [statusTrail, status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, liveText, traces.length, statuses.length]);

  if (messages.length === 0 && !liveText && traces.length === 0 && statuses.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="rounded-2xl border border-border/60 bg-card/70 px-5 py-4 text-center backdrop-blur-sm">
          <p className="font-display text-sm tracking-wide text-foreground/90">No messages yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Send a prompt to get started</p>
        </div>
      </div>
    );
  }

  return (
    <div className="scroll-soft relative flex-1 overflow-auto">
      <div className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle_at_6%_6%,hsl(var(--primary)/0.18),transparent_45%),radial-gradient(circle_at_90%_10%,hsl(var(--accent)/0.12),transparent_36%),linear-gradient(180deg,hsl(var(--background)),hsl(var(--background)/0.88))]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:linear-gradient(to_right,hsl(var(--foreground))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--foreground))_1px,transparent_1px)] [background-size:10px_10px]" />
      <div className="relative mx-auto max-w-4xl px-4 py-5">
        <div className="grid gap-4">
          {messages.map((message) => (
            <article
              key={message.id}
              className={cn(
                'group max-w-[90%] animate-rise rounded-2xl border px-4 py-3 shadow-[0_14px_45px_hsl(var(--shadow)/0.25)]',
                message.role === 'user'
                  ? 'ml-auto border-primary/[0.35] bg-primary/10'
                  : 'mr-auto border-border/60 bg-card/[0.65] backdrop-blur-sm'
              )}
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className={cn(
                    'font-display text-[10px] uppercase tracking-[0.2em]',
                    message.role === 'user' ? 'text-primary/90' : 'text-foreground/[0.55]'
                  )}
                >
                  {roleLabel(message.role)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{message.content}</p>
            </article>
          ))}

          {(statuses.length > 0 || streaming) && (
            <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/[0.65] p-4 shadow-[0_14px_45px_hsl(var(--shadow)/0.2)] backdrop-blur-sm">
              <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(130deg,hsl(var(--primary)/0.14),transparent_60%)]" />
              <div className="relative">
                <div className="mb-3 flex items-center gap-2">
                  <Loader2 className={cn('h-3.5 w-3.5 text-primary', streaming && 'animate-spin')} />
                  <span className="font-display text-[10px] uppercase tracking-[0.2em] text-foreground/[0.55]">
                    Live Activity
                  </span>
                </div>
                <ol className="grid gap-1.5">
                  {statuses.map((entry, index) => (
                    <li key={`${entry}-${index}`} className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/[0.35] px-2.5 py-2">
                      <span
                        className={cn(
                          'mt-1 h-1.5 w-1.5 rounded-full bg-primary/80',
                          streaming && index === statuses.length - 1 && 'animate-pulse'
                        )}
                      />
                      <span className="text-[12px] leading-relaxed text-foreground/[0.85]">{entry}</span>
                    </li>
                  ))}
                  {statuses.length === 0 && streaming && (
                    <li className="rounded-lg border border-border/40 bg-background/[0.35] px-2.5 py-2 text-[12px] text-foreground/80">
                      Loading execution events...
                    </li>
                  )}
                </ol>
              </div>
            </section>
          )}

          {traces.map((trace, index) => {
            const parsed = parseTrace(trace);
            const meta = TRACE_META[trace.traceKind];
            const Icon = meta.icon;

            return (
              <article
                key={`${trace.traceKind}-${index}`}
                className={cn(
                  'animate-rise rounded-2xl border p-4 shadow-[0_14px_45px_hsl(var(--shadow)/0.22)] backdrop-blur-sm',
                  meta.cardClass
                )}
                style={{ animationDelay: `${index * 70}ms` }}
              >
                <div className="mb-3 flex items-center gap-2">
                  <Icon className={cn('h-3.5 w-3.5', meta.accentClass)} />
                  <span className={cn('font-display text-[10px] uppercase tracking-[0.2em]', meta.accentClass)}>
                    {meta.label}
                  </span>
                  <span className="ml-auto text-[10px] text-foreground/[0.45]">#{index + 1}</span>
                </div>

                {parsed.kind === 'checklist' && (
                  <ul className="grid gap-2">
                    {parsed.items.map((item) => (
                      <li
                        key={`${item.index}-${item.text}`}
                        className={cn(
                          'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[12px]',
                          item.done ? 'border-emerald-300/[0.35] bg-emerald-300/10' : 'border-border/50 bg-background/[0.35]'
                        )}
                      >
                        {item.done ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-300" />
                        ) : (
                          <Circle className="mt-0.5 h-3.5 w-3.5 text-foreground/[0.45]" />
                        )}
                        <span className="leading-relaxed text-foreground/[0.85]">
                          {item.index}. {item.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {parsed.kind === 'command' && (
                  <div className="grid gap-2">
                    <div className="rounded-lg border border-border/50 bg-black/[0.35] px-2.5 py-2.5">
                      <pre className="overflow-x-auto whitespace-pre-wrap text-[12px] leading-relaxed text-emerald-200">
                        <code>{parsed.command}</code>
                      </pre>
                    </div>
                    {parsed.cwd && (
                      <div className="rounded-lg border border-border/50 bg-background/[0.35] px-2.5 py-2 text-[11px] text-foreground/70">
                        cwd: <span className="font-mono text-[11px] text-foreground/[0.85]">{parsed.cwd}</span>
                      </div>
                    )}
                  </div>
                )}

                {parsed.kind === 'result' && (
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background/[0.35] px-2.5 py-2">
                      <span className="font-display text-[10px] uppercase tracking-[0.15em] text-foreground/[0.55]">
                        Exit
                      </span>
                      <span
                        className={cn(
                          'rounded-md border px-2 py-0.5 font-mono text-[11px]',
                          parsed.exit === '0'
                            ? 'border-emerald-300/[0.35] bg-emerald-300/10 text-emerald-200'
                            : 'border-rose-300/[0.35] bg-rose-300/10 text-rose-200'
                        )}
                      >
                        {parsed.exit ?? 'n/a'}
                      </span>
                      {parsed.timedOut && (
                        <span className="rounded-md border border-amber-300/[0.35] bg-amber-300/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-amber-200">
                          timeout
                        </span>
                      )}
                    </div>
                    {parsed.stdout && (
                      <details className="rounded-lg border border-border/50 bg-background/[0.35] px-2.5 py-2">
                        <summary className="cursor-pointer font-display text-[10px] uppercase tracking-[0.15em] text-foreground/60">
                          stdout
                        </summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/[0.85]">
                          <code>{parsed.stdout}</code>
                        </pre>
                      </details>
                    )}
                    {parsed.stderr && (
                      <details className="rounded-lg border border-border/50 bg-background/[0.35] px-2.5 py-2">
                        <summary className="cursor-pointer font-display text-[10px] uppercase tracking-[0.15em] text-foreground/60">
                          stderr
                        </summary>
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] leading-relaxed text-rose-200/90">
                          <code>{parsed.stderr}</code>
                        </pre>
                      </details>
                    )}
                  </div>
                )}

                {parsed.kind === 'note' && (
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/[0.88]">{parsed.text}</p>
                )}

                {(parsed.changeSummary || parsed.fileLocations.length > 0) && (
                  <div className="mt-3 grid gap-2">
                    {parsed.changeSummary && (
                      <div className="inline-flex w-fit items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-primary-foreground/[0.85]">
                        <FileCode2 className="h-3 w-3" />
                        <span>{parsed.changeSummary}</span>
                      </div>
                    )}
                    {parsed.fileLocations.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {parsed.fileLocations.map((location) => (
                          <span
                            key={location}
                            className="rounded-md border border-border/50 bg-background/[0.35] px-2 py-1 font-mono text-[10px] text-foreground/75"
                          >
                            {location}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}

          {(liveText || streaming) && (
            <article className="relative overflow-hidden rounded-2xl border border-primary/[0.35] bg-primary/10 p-4 shadow-[0_14px_45px_hsl(var(--shadow)/0.22)]">
              <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(140deg,hsl(var(--primary)/0.2),transparent_60%)]" />
              <div className="relative">
                <div className="mb-2 flex items-center gap-2">
                  <Sparkles className={cn('h-3.5 w-3.5 text-primary', streaming && 'animate-pulse')} />
                  <span className="font-display text-[10px] uppercase tracking-[0.2em] text-primary/[0.85]">
                    Assistant Draft
                  </span>
                </div>
                {liveText ? (
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{liveText}</p>
                ) : (
                  <p className="text-[12px] text-foreground/[0.65]">Preparing response...</p>
                )}
              </div>
            </article>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
};
