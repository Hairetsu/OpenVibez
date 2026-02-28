import {
  CheckCircle2,
  ChevronRight,
  Circle,
  FileCode2,
  FilePenLine,
  Search,
  TerminalSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineGroup as TimelineGroupType } from "./types";
import { summarizeAction } from "./parsers";
import {
  basename,
  commandPreview,
  extractInlineFiles,
  formatCommandForDisplay,
} from "./utils";
import { MarkdownText } from "./MarkdownText";

export const TimelineGroupRenderer = ({
  group,
  groupKey,
  skipAnimation = false,
}: {
  group: TimelineGroupType;
  groupKey: string;
  skipAnimation?: boolean;
}) => {
  const anim = skipAnimation ? "" : "animate-rise";
  if (group.kind === "text") {
    const inlineFiles = extractInlineFiles(group.content);
    return (
      <div key={groupKey} className={cn(anim, "grid gap-1.5")}>
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
      <div key={groupKey} className={cn(anim, "grid gap-1")}>
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
      <div key={groupKey} className={cn(anim, "grid gap-1")}>
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
      <div key={groupKey} className={cn(anim, "flex items-center gap-2")}>
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
      <div key={groupKey} className={cn(anim, "grid gap-1")}>
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
      <ul key={groupKey} className={cn(anim, "grid gap-1")}>
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
    <div key={groupKey} className={cn(anim, "grid gap-1")}>
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
