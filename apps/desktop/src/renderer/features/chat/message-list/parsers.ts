import type { MessageStreamTrace } from "../../../../preload/types";
import type { ActionSummary, ChecklistItem, FileEdit } from "./types";

const CHECKLIST_LINE = /^\[(x| )\]\s+(\d+)\.\s+(.+)$/i;
const FILE_LOCATION_PATTERN =
  /(?:^|[\s`"'([{])((?:\/|\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?)/g;
const FILE_OP_PATTERN = /\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+)/g;
const SEARCH_PATTERN = /\b(?:Searched\s+for|Explored|search|grep|rg\s|find\s)/i;

export const extractFileLocations = (text: string): string[] => {
  const matches: string[] = [];
  for (const found of text.matchAll(FILE_LOCATION_PATTERN)) {
    const value = found[1]?.trim().replace(/[),.;]+$/, "");
    if (!value || /^https?:\/\//i.test(value)) continue;
    matches.push(value);
  }
  return [...new Set(matches)].slice(0, 8);
};

export const parseFileEdits = (text: string): FileEdit[] | null => {
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

export const parseChecklist = (text: string): ChecklistItem[] | null => {
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

export const parseCommand = (
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

export const parseResult = (
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

export const summarizeAction = (trace: MessageStreamTrace): ActionSummary => {
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
