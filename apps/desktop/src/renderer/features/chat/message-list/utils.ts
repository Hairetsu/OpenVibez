import type { Message } from "../../../../preload/types";
import type { StreamTimelineEntry } from "../chat.store";
import type { TimelineGroup } from "./types";

const BACKTICK_PATH = /`([^`]*(?:\/[^`]+|\.[a-z0-9]{1,10}))`/gi;

export const roleLabel = (role: Message["role"]): string => {
  if (role === "user") return "You";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return "Tool";
  return "System";
};

export const basename = (filePath: string): string => {
  const parts = filePath.split("/");
  return parts[parts.length - 1] ?? filePath;
};

export const ellipsizeMiddle = (value: string, max = 120): string => {
  if (value.length <= max) return value;
  const keep = Math.max(8, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(value.length - keep)}`;
};

export const splitCommandByTopLevelOperators = (command: string): string[] => {
  const parts: string[] = [];
  let buffer = "";
  let singleQuote = false;
  let doubleQuote = false;
  let escaped = false;

  const flushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) parts.push(trimmed);
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

export const formatCommandForDisplay = (command: string): string => {
  const pieces = splitCommandByTopLevelOperators(command);
  if (pieces.length <= 1) return command;

  let output = pieces[0] ?? "";
  for (let i = 1; i < pieces.length; i += 2) {
    const op = pieces[i];
    const next = pieces[i + 1] ?? "";

    if (!op || !next) continue;

    if (op === ";") {
      output += `;\n${next}`;
    } else {
      output += ` \\\n  ${op} ${next}`;
    }
  }

  return output;
};

export const commandPreview = (command: string): string => {
  const compact = command.replace(/\s+/g, " ").trim();
  return ellipsizeMiddle(compact, 120);
};

export const extractInlineFiles = (text: string): string[] => {
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

export const buildTimelineGroups = (
  timeline: StreamTimelineEntry[],
): { groups: TimelineGroup[]; currentThought: string | null } => {
  const groups: TimelineGroup[] = [];
  let currentThought: string | null = null;

  for (const entry of timeline) {
    if (entry.type === "run_marker") continue;

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

export const splitTimelineByRunMarkers = (
  timeline: StreamTimelineEntry[],
): { segments: StreamTimelineEntry[][]; hasMarkers: boolean } => {
  const segments: StreamTimelineEntry[][] = [];
  let current: StreamTimelineEntry[] = [];
  let hasMarkers = false;

  for (const entry of timeline) {
    if (entry.type === "run_marker") {
      hasMarkers = true;
      segments.push(current);
      current = [];
      continue;
    }

    current.push(entry);
  }

  if (current.length > 0 || hasMarkers) segments.push(current);

  return { segments, hasMarkers };
};
