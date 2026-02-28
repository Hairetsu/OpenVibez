import type { Message, MessageStreamTrace } from "../../../../preload/types";
import type { StreamTimelineEntry } from "../chat.store";

export type MessageListProps = {
  messages: Message[];
  liveText?: string;
  streaming?: boolean;
  traces?: MessageStreamTrace[];
  timeline?: StreamTimelineEntry[];
  status?: string | null;
  statusTrail?: string[];
};

export type ChecklistItem = { done: boolean; index: number; text: string };

export type FileEdit = {
  path: string;
  verb: string;
  added: number;
  removed: number;
};

export type ActionSummary =
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

export type TimelineGroup =
  | { kind: "action"; trace: MessageStreamTrace; text: string }
  | { kind: "text"; content: string };
