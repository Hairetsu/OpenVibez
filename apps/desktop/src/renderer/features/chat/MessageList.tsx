import { useEffect, useMemo, useRef } from "react";
import type { Message, MessageStreamTrace } from "../../../preload/types";
import type { StreamTimelineEntry } from "./chat.store";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  FileCode2,
  FilePenLine,
  Loader2,
  Search,
  TerminalSquare,
} from "lucide-react";

type MessageListProps = {
  messages: Message[];
  liveText?: string;
  streaming?: boolean;
  traces?: MessageStreamTrace[];
  timeline?: StreamTimelineEntry[];
  status?: string | null;
  statusTrail?: string[];
};

type ChecklistItem = { done: boolean; index: number; text: string };

type FileEdit = { path: string; verb: string; added: number; removed: number };

type ActionSummary =
  | { type: "edited"; files: FileEdit[]; raw: string }
  | { type: "command"; command: string; cwd: string | null; raw: string }
  | {
      type: "result";
      exit: string | null;
      timedOut: boolean;
      stdout: string | null;
      stderr: string | null;
    }
  | { type: "explored"; count: number; detail: string; raw: string }
  | { type: "checklist"; items: ChecklistItem[] }
  | { type: "text"; content: string; files: string[] };

const CHECKLIST_LINE = /^\[(x| )\]\s+(\d+)\.\s+(.+)$/i;
const FILE_LOCATION_PATTERN =
  /(?:^|[\s`"'([{])((?:\/|\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?)/g;
const FILE_OP_PATTERN = /\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+)/g;
const SEARCH_PATTERN = /\b(?:Searched\s+for|Explored|search|grep|rg\s|find\s)/i;

const extractFileLocations = (text: string): string[] => {
  const matches: string[] = [];
  for (const found of text.matchAll(FILE_LOCATION_PATTERN)) {
    const value = found[1]?.trim().replace(/[),.;]+$/, "");
    if (!value || /^https?:\/\//i.test(value)) continue;
    matches.push(value);
  }
  return [...new Set(matches)].slice(0, 8);
};

const parseFileEdits = (text: string): FileEdit[] | null => {
  const edits: FileEdit[] = [];
  for (const m of text.matchAll(FILE_OP_PATTERN)) {
    const verb = m[1].toLowerCase();
    const filePath = m[2].trim();
    const section = text.slice(m.index! + m[0].length);
    const nextOp = section.search(/\*\*\*\s+(?:Add|Update|Delete)\s+File:/);
    const chunk = nextOp === -1 ? section : section.slice(0, nextOp);
    let added = 0;
    let removed = 0;
    for (const line of chunk.split("\n")) {
      if (/^\+[^+]/.test(line)) added++;
      if (/^-[^-]/.test(line)) removed++;
    }
    edits.push({ path: filePath, verb, added, removed });
  }
  return edits.length > 0 ? edits : null;
};

const parseChecklist = (text: string): ChecklistItem[] | null => {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const parsed = lines.map((line) => {
    const match = line.match(CHECKLIST_LINE);
    if (!match) return null;
    return {
      done: match[1].toLowerCase() === "x",
      index: Number(match[2]),
      text: match[3].trim(),
    };
  });
  if (parsed.some((e) => !e)) return null;
  return parsed as ChecklistItem[];
};

const parseCommand = (
  text: string,
): { command: string; cwd: string | null } | null => {
  const lines = text.split(/\r?\n/);
  if (lines.length < 1) return null;
  const header = lines[0]?.trim() ?? "";
  const hasKnownHeader =
    /^Step\s+\d+\s+command:\s*$/i.test(header) ||
    /^command(?:_execution)?:\s*$/i.test(header) ||
    /^\$ /.test(header);
  if (!hasKnownHeader) return null;
  const commandStart = /^\$ /.test(header) ? 0 : 1;
  const cwdIdx = lines.findIndex(
    (l, i) => i >= commandStart && /^cwd:\s*/i.test(l.trim()),
  );
  const commandLines = lines
    .slice(commandStart, cwdIdx === -1 ? undefined : cwdIdx)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (commandLines.length === 0) return null;
  const cwd =
    cwdIdx === -1
      ? null
      : lines[cwdIdx]
          ?.trim()
          .replace(/^cwd:\s*/i, "")
          .trim() || null;
  return { command: commandLines.join("\n"), cwd };
};

const parseResult = (
  text: string,
): {
  exit: string | null;
  timedOut: boolean;
  stdout: string | null;
  stderr: string | null;
} | null => {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!/^exit:\s*/i.test(firstLine)) return null;
  const exit = firstLine.replace(/^exit:\s*/i, "").trim() || null;
  const stdout =
    text
      .match(/(?:^|\n)stdout:\n([\s\S]*?)(?=\n(?:stderr:|$))/i)?.[1]
      ?.trim() ?? null;
  const stderr =
    text.match(/(?:^|\n)stderr:\n([\s\S]*)$/i)?.[1]?.trim() ?? null;
  return { exit, timedOut: /\(timeout\)/i.test(firstLine), stdout, stderr };
};

const summarizeAction = (trace: MessageStreamTrace): ActionSummary => {
  const text = trace.text.trim();
  const kind = trace.actionKind;

  const checklist = parseChecklist(text);
  if (checklist) return { type: "checklist", items: checklist };

  if (
    kind === "file-edit" ||
    kind === "file-create" ||
    kind === "file-delete"
  ) {
    const patchEdits = parseFileEdits(text);
    if (patchEdits) return { type: "edited", files: patchEdits, raw: text };
    const files = extractFileLocations(text);
    const verb =
      kind === "file-create"
        ? "add"
        : kind === "file-delete"
          ? "delete"
          : "update";
    if (files.length > 0) {
      return {
        type: "edited",
        files: files.map((f) => ({ path: f, verb, added: 0, removed: 0 })),
        raw: text,
      };
    }
    return {
      type: "edited",
      files: [
        { path: text.split("\n")[0] ?? "file", verb, added: 0, removed: 0 },
      ],
      raw: text,
    };
  }

  if (kind === "file-read") {
    const files = extractFileLocations(text);
    return {
      type: "explored",
      count: files.length || 1,
      detail: text,
      raw: text,
    };
  }

  if (kind === "search") {
    const searchLines = text
      .split(/\r?\n/)
      .filter((l) => /search|grep|rg\s|find\s|Searched|list/i.test(l));
    return {
      type: "explored",
      count: Math.max(searchLines.length, 1),
      detail: text,
      raw: text,
    };
  }

  if (kind === "command") {
    const parsed = parseCommand(text);
    if (parsed)
      return {
        type: "command",
        command: parsed.command,
        cwd: parsed.cwd,
        raw: text,
      };
    const firstLine = text.split("\n")[0] ?? text;
    return { type: "command", command: firstLine, cwd: null, raw: text };
  }

  if (kind === "command-result") {
    const parsed = parseResult(text);
    if (parsed)
      return {
        type: "result",
        exit: parsed.exit,
        timedOut: parsed.timedOut,
        stdout: parsed.stdout,
        stderr: parsed.stderr,
      };
    return {
      type: "result",
      exit: null,
      timedOut: false,
      stdout: text,
      stderr: null,
    };
  }

  const command = parseCommand(text);
  if (command)
    return {
      type: "command",
      command: command.command,
      cwd: command.cwd,
      raw: text,
    };

  const result = parseResult(text);
  if (result)
    return {
      type: "result",
      exit: result.exit,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };

  const fileEdits = parseFileEdits(text);
  if (fileEdits) return { type: "edited", files: fileEdits, raw: text };

  if (SEARCH_PATTERN.test(text)) {
    const searchLines = text
      .split(/\r?\n/)
      .filter((l) => /search|grep|rg\s|find\s|Searched/i.test(l));
    return {
      type: "explored",
      count: Math.max(searchLines.length, 1),
      detail: text,
      raw: text,
    };
  }

  return { type: "text", content: text, files: extractFileLocations(text) };
};

const roleLabel = (role: Message["role"]): string => {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  return "System";
};

type TimelineGroup =
  | { kind: "action"; trace: MessageStreamTrace; text: string }
  | { kind: "text"; content: string };

const buildTimelineGroups = (
  timeline: StreamTimelineEntry[],
): { groups: TimelineGroup[]; currentThought: string | null } => {
  const groups: TimelineGroup[] = [];
  let currentThought: string | null = null;

  for (const entry of timeline) {
    if (entry.type === "run_marker") {
      continue;
    }

    if (entry.type === "trace") {
      if (entry.trace.traceKind === "thought") {
        currentThought = entry.trace.text.trim();
      } else {
        groups.push({ kind: "action", trace: entry.trace, text: "" });
      }
    } else if (entry.type === "text") {
      groups.push({ kind: "text", content: entry.content });
    }
  }

  // If the stream ends in text->action due late action event delivery,
  // keep the final action above the final prose block.
  if (groups.length >= 2) {
    const last = groups[groups.length - 1];
    const prev = groups[groups.length - 2];
    if (last.kind === "action" && prev.kind === "text") {
      groups[groups.length - 2] = last;
      groups[groups.length - 1] = prev;
    }
  }

  return { groups, currentThought };
};

const splitTimelineByRunMarkers = (
  timeline: StreamTimelineEntry[],
): { segments: StreamTimelineEntry[][]; hasMarkers: boolean } => {
  const segments: StreamTimelineEntry[][] = [];
  let current: StreamTimelineEntry[] = [];
  let hasMarkers = false;

  for (const entry of timeline) {
    if (entry.type === "run_marker") {
      hasMarkers = true;
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }

    current.push(entry);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return { segments, hasMarkers };
};

const basename = (filePath: string): string => {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
};

const ellipsizeMiddle = (value: string, max = 120): string => {
  if (value.length <= max) {
    return value;
  }

  const keep = Math.max(8, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
};

const splitCommandByTopLevelOperators = (command: string): string[] => {
  const parts: string[] = [];
  let buffer = "";
  let singleQuote = false;
  let doubleQuote = false;
  let escaped = false;

  const flushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
    buffer = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (escaped) {
      buffer += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      buffer += ch;
      escaped = true;
      continue;
    }

    if (!doubleQuote && ch === "'") {
      singleQuote = !singleQuote;
      buffer += ch;
      continue;
    }

    if (!singleQuote && ch === '"') {
      doubleQuote = !doubleQuote;
      buffer += ch;
      continue;
    }

    if (!singleQuote && !doubleQuote) {
      const next = command[i + 1] ?? "";

      if (ch === "&" && next === "&") {
        flushBuffer();
        parts.push("&&");
        i += 1;
        continue;
      }

      if (ch === "|" && next === "|") {
        flushBuffer();
        parts.push("||");
        i += 1;
        continue;
      }

      if (ch === "|" || ch === ";") {
        flushBuffer();
        parts.push(ch);
        continue;
      }
    }

    buffer += ch;
  }

  flushBuffer();
  return parts;
};

const formatCommandForDisplay = (command: string): string => {
  const pieces = splitCommandByTopLevelOperators(command);
  if (pieces.length <= 1) {
    return command;
  }

  let output = pieces[0] ?? "";
  for (let i = 1; i < pieces.length; i += 2) {
    const op = pieces[i];
    const next = pieces[i + 1] ?? "";

    if (!op || !next) {
      continue;
    }

    if (op === ";") {
      output += `;\n${next}`;
    } else {
      output += ` \\\n  ${op} ${next}`;
    }
  }

  return output;
};

const commandPreview = (command: string): string => {
  const compact = command.replace(/\s+/g, " ").trim();
  return ellipsizeMiddle(compact, 120);
};

const BACKTICK_PATH = /`([^`]*(?:\/[^`]+|\.[a-z0-9]{1,10}))`/gi;

const extractInlineFiles = (text: string): string[] => {
  const matches: string[] = [];
  for (const m of text.matchAll(BACKTICK_PATH)) {
    const val = m[1]?.trim();
    if (
      !val ||
      /^https?:\/\//i.test(val) ||
      val.includes(" ") ||
      val.length > 120
    )
      continue;
    matches.push(val);
  }
  return [...new Set(matches)].slice(0, 12);
};

const MarkdownText = ({
  content,
  className,
}: {
  content: string;
  className?: string;
}) => (
  <div className={cn("markdown-text", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => (
          <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>
        ),
        li: ({ children }) => <li className="mb-0.5">{children}</li>,
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-sky-300 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-200"
          >
            {children}
          </a>
        ),
        code: ({ className: codeClassName, children }) => {
          const raw = String(children);
          const isBlock = raw.includes("\n");
          if (!isBlock) {
            return (
              <code
                className={cn(
                  "rounded border border-border/40 bg-black/20 px-1 py-0.5 font-mono text-[11px] text-emerald-200/90",
                  codeClassName,
                )}
              >
                {children}
              </code>
            );
          }

          return (
            <code
              className={cn(
                "block font-mono text-[11px] leading-relaxed",
                codeClassName,
              )}
            >
              {children}
            </code>
          );
        },
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-lg border border-border/30 bg-black/35 px-3 py-2">
            {children}
          </pre>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);

export const MessageList = ({
  messages,
  liveText,
  streaming,
  traces = [],
  timeline = [],
  status,
  statusTrail = [],
}: MessageListProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  const { assistantGroupsById, liveTimelineGroups, liveCurrentThought } =
    useMemo(() => {
      const assistantMessages = messages.filter(
        (message) => message.role === "assistant",
      );
      const { segments, hasMarkers } = splitTimelineByRunMarkers(timeline);

      const byAssistantId: Record<string, TimelineGroup[]> = {};
      let liveGroups: TimelineGroup[] = [];
      let currentThought: string | null = null;

      if (hasMarkers) {
        const pendingSegments = [...segments];

        if (streaming && pendingSegments.length > 0) {
          const liveBuilt = buildTimelineGroups(
            pendingSegments.pop() ?? [],
          );
          liveGroups = liveBuilt.groups;
          currentThought = liveBuilt.currentThought;
        }

        for (
          let assistantIndex = assistantMessages.length - 1,
            segmentIndex = pendingSegments.length - 1;
          assistantIndex >= 0 && segmentIndex >= 0;
          assistantIndex -= 1, segmentIndex -= 1
        ) {
          byAssistantId[assistantMessages[assistantIndex].id] =
            buildTimelineGroups(pendingSegments[segmentIndex] ?? []).groups;
        }
      } else if (segments.length > 0) {
        if (assistantMessages.length > 0) {
          byAssistantId[assistantMessages[assistantMessages.length - 1].id] =
            buildTimelineGroups(segments[segments.length - 1] ?? []).groups;
        }

        if (streaming) {
          const liveBuilt = buildTimelineGroups(
            segments[segments.length - 1] ?? [],
          );
          liveGroups = liveBuilt.groups;
          currentThought = liveBuilt.currentThought;
        }
      }

      return {
        assistantGroupsById: byAssistantId,
        liveTimelineGroups: liveGroups,
        liveCurrentThought: currentThought,
      };
    }, [messages, streaming, timeline]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, liveTimelineGroups.length, liveCurrentThought]);

  if (
    messages.length === 0 &&
    !liveText &&
    traces.length === 0 &&
    timeline.length === 0
  ) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="rounded-2xl border border-border/60 bg-card/70 px-5 py-4 text-center backdrop-blur-sm">
          <p className="font-display text-sm tracking-wide text-foreground/90">
            No messages yet
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Send a prompt to get started
          </p>
        </div>
      </div>
    );
  }

  const renderTimelineGroup = (group: TimelineGroup, key: string) => {
    if (group.kind === "text") {
      const inlineFiles = extractInlineFiles(group.content);
      return (
        <div key={key} className="animate-rise grid gap-1.5">
          <MarkdownText
            content={group.content}
            className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/75"
          />
          {inlineFiles.length > 0 && (
            <details className="group/det rounded-lg border border-border/40 bg-card/40">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px]">
                <ChevronRight className="h-3 w-3 text-foreground/40 transition-transform group-open/det:rotate-90" />
                <Search className="h-3 w-3 text-sky-400/70" />
                <span className="text-foreground/70">
                  Explored {inlineFiles.length} file
                  {inlineFiles.length !== 1 ? "s" : ""}
                </span>
              </summary>
              <div className="flex flex-wrap gap-1.5 border-t border-border/30 px-3 py-2">
                {inlineFiles.map((f) => (
                  <span
                    key={f}
                    className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-card/50 px-1.5 py-0.5 font-mono text-[10px] text-foreground/55"
                  >
                    <FileCode2 className="h-2.5 w-2.5" />
                    {f}
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>
      );
    }

    const summary = summarizeAction(group.trace);

    if (summary.type === "edited") {
      return (
        <div key={key} className="animate-rise grid gap-1">
          {group.text && (
            <MarkdownText
              content={group.text}
              className="text-[12px] leading-relaxed text-foreground/75"
            />
          )}
          {summary.files.map((file) => (
            <details
              key={file.path}
              className="group/det rounded-lg border border-border/40 bg-card/40"
            >
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px]">
                <ChevronRight className="h-3 w-3 text-foreground/40 transition-transform group-open/det:rotate-90" />
                <FilePenLine className="h-3 w-3 text-foreground/50" />
                <span className="font-medium text-foreground/80">
                  {file.verb === "add"
                    ? "Created"
                    : file.verb === "delete"
                      ? "Deleted"
                      : "Edited"}{" "}
                  {basename(file.path)}
                </span>
                {(file.added > 0 || file.removed > 0) && (
                  <span className="ml-auto flex gap-1.5 font-mono text-[10px]">
                    {file.added > 0 && (
                      <span className="text-emerald-400">+{file.added}</span>
                    )}
                    {file.removed > 0 && (
                      <span className="text-rose-400">-{file.removed}</span>
                    )}
                  </span>
                )}
              </summary>
              <div className="border-t border-border/30 px-3 py-2">
                <span className="font-mono text-[10px] text-foreground/50">
                  {file.path}
                </span>
              </div>
            </details>
          ))}
        </div>
      );
    }

    if (summary.type === "command") {
      const formattedCommand = formatCommandForDisplay(summary.command);
      const preview = commandPreview(
        summary.command.split("\n")[0] ?? summary.command,
      );
      return (
        <div key={key} className="animate-rise grid gap-1">
          {group.text && (
            <MarkdownText
              content={group.text}
              className="text-[12px] leading-relaxed text-foreground/75"
            />
          )}
          <details className="group/det rounded-lg border border-border/40 bg-card/40">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px]">
              <ChevronRight className="h-3 w-3 text-foreground/40 transition-transform group-open/det:rotate-90" />
              <TerminalSquare className="h-3 w-3 text-emerald-400/70" />
              <span className="min-w-0 flex-1 truncate font-mono text-foreground/70">
                {preview}
              </span>
            </summary>
            <div className="border-t border-border/30 bg-black/20 px-3 py-2">
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-emerald-200/80">
                <code>{formattedCommand}</code>
              </pre>
              {summary.cwd && (
                <p className="mt-1.5 font-mono text-[10px] text-foreground/40">
                  cwd: {summary.cwd}
                </p>
              )}
            </div>
          </details>
        </div>
      );
    }

    if (summary.type === "result") {
      return (
        <div key={key} className="animate-rise flex items-center gap-2">
          <span
            className={cn(
              "rounded-md border px-1.5 py-0.5 font-mono text-[10px]",
              summary.exit === "0"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : "border-rose-400/30 bg-rose-400/10 text-rose-300",
            )}
          >
            exit {summary.exit ?? "?"}
          </span>
          {summary.timedOut && (
            <span className="rounded-md border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-300">
              timeout
            </span>
          )}
          {summary.stdout && (
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer text-[10px] text-foreground/40 hover:text-foreground/60">
                stdout
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border/30 bg-black/20 px-2 py-1.5 text-[11px] leading-relaxed text-foreground/70">
                <code>{summary.stdout}</code>
              </pre>
            </details>
          )}
          {summary.stderr && (
            <details className="min-w-0 flex-1">
              <summary className="cursor-pointer text-[10px] text-foreground/40 hover:text-foreground/60">
                stderr
              </summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border/30 bg-black/20 px-2 py-1.5 text-[11px] leading-relaxed text-rose-200/70">
                <code>{summary.stderr}</code>
              </pre>
            </details>
          )}
        </div>
      );
    }

    if (summary.type === "explored") {
      return (
        <div key={key} className="animate-rise grid gap-1">
          {group.text && (
            <MarkdownText
              content={group.text}
              className="text-[12px] leading-relaxed text-foreground/75"
            />
          )}
          <details className="group/det rounded-lg border border-border/40 bg-card/40">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px]">
              <ChevronRight className="h-3 w-3 text-foreground/40 transition-transform group-open/det:rotate-90" />
              <Search className="h-3 w-3 text-sky-400/70" />
              <span className="text-foreground/70">
                Explored {summary.count} search
                {summary.count !== 1 ? "es" : ""}
              </span>
            </summary>
            <div className="border-t border-border/30 px-3 py-2">
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground/50">
                {summary.detail}
              </pre>
            </div>
          </details>
        </div>
      );
    }

    if (summary.type === "checklist") {
      return (
        <ul key={key} className="animate-rise grid gap-1">
          {summary.items.map((item) => (
            <li
              key={`${item.index}-${item.text}`}
              className="flex items-start gap-2 text-[12px]"
            >
              {item.done ? (
                <CheckCircle2 className="mt-0.5 h-3 w-3 text-emerald-400" />
              ) : (
                <Circle className="mt-0.5 h-3 w-3 text-foreground/25" />
              )}
              <span
                className={cn(
                  "leading-relaxed",
                  item.done ? "text-foreground/60" : "text-foreground/80",
                )}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      );
    }

    return (
      <div key={key} className="animate-rise grid gap-1">
        {group.text && (
          <MarkdownText
            content={group.text}
            className="text-[12px] leading-relaxed text-foreground/75"
          />
        )}
        {summary.content && !group.text && (
          <MarkdownText
            content={summary.content}
            className="text-[12px] leading-relaxed text-foreground/75"
          />
        )}
        {summary.files.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {summary.files.map((loc) => (
              <span
                key={loc}
                className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-card/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/55"
              >
                <FileCode2 className="h-2.5 w-2.5" />
                {basename(loc)}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="scroll-soft relative flex-1 overflow-auto [background:radial-gradient(ellipse_at_0%_0%,hsl(var(--primary)/0.03),transparent_60%),radial-gradient(ellipse_at_100%_100%,hsl(var(--accent)/0.03),transparent_60%)] [background-attachment:fixed]">
      <div className="relative mx-auto max-w-4xl px-4 py-5">
        <div className="grid gap-3">
          {messages.map((message) => {
            if (message.role === "assistant") {
              const mappedGroups = assistantGroupsById[message.id] ?? [];
              const hasTextGroup = mappedGroups.some(
                (group) =>
                  group.kind === "text" && group.content.trim().length > 0,
              );
              const fallbackTextGroup: TimelineGroup = {
                kind: "text",
                content: message.content,
              };
              const groupsToRender =
                hasTextGroup || !message.content.trim()
                  ? mappedGroups
                  : [...mappedGroups, fallbackTextGroup];

              if (groupsToRender.length > 0) {
                return (
                  <div key={message.id} className="grid gap-1.5">
                    {groupsToRender.map((group, index) =>
                      renderTimelineGroup(group, `${message.id}-${index}`),
                    )}
                  </div>
                );
              }

              return (
                <article
                  key={message.id}
                  className="mr-auto max-w-[90%] rounded-2xl border border-border/60 bg-card/[0.65] px-4 py-3 shadow-[0_14px_45px_hsl(var(--shadow)/0.05)] backdrop-blur-sm"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-display text-[10px] uppercase tracking-[0.2em] text-foreground/[0.55]">
                      {roleLabel(message.role)}
                    </span>
                  </div>
                  <MarkdownText
                    content={message.content}
                    className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90"
                  />
                </article>
              );
            }

            return (
              <article
                key={message.id}
                className={cn(
                  "group max-w-[90%] rounded-2xl border px-4 py-3 shadow-[0_14px_45px_hsl(var(--shadow)/0.05)]",
                  message.role === "user"
                    ? "ml-auto "
                    : "mr-auto border-border/60 bg-card/[0.65] backdrop-blur-sm",
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={cn(
                      "font-display text-[10px] uppercase tracking-[0.2em]",
                      message.role === "user"
                        ? "text-primary/90"
                        : "text-foreground/[0.55]",
                    )}
                  >
                    {roleLabel(message.role)}
                  </span>
                </div>
                <MarkdownText
                  content={message.content}
                  className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90"
                />
              </article>
            );
          })}

          {liveTimelineGroups.map((group, index) =>
            renderTimelineGroup(group, `live-${index}`),
          )}

          {streaming && (
            <div className="flex items-center gap-2 py-1">
              <Loader2 className="h-3 w-3 animate-spin text-foreground/40" />
              <span className="text-[11px] text-foreground/50">
                {liveCurrentThought ?? status ?? "Thinking..."}
              </span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
};
