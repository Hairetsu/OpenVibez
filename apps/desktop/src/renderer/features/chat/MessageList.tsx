import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { MessageListProps, TimelineGroup } from "./message-list/types";
import { buildTimelineGroups, roleLabel, splitTimelineByRunMarkers } from "./message-list/utils";
import { MarkdownText } from "./message-list/MarkdownText";
import { TimelineGroupRenderer } from "./message-list/TimelineGroup";

export type { MessageListProps };

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
  const wasStreamingRef = useRef(false);
  const justTransitioned = wasStreamingRef.current && !(streaming ?? false);
  wasStreamingRef.current = streaming ?? false;

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

  const lastAssistantId = messages.filter((m) => m.role === "assistant").at(-1)?.id;

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
              const suppressAnim = justTransitioned && message.id === lastAssistantId;

              if (groupsToRender.length > 0) {
                return (
                  <div key={message.id} className="grid gap-1.5">
                    {groupsToRender.map((group, index) => (
                      <TimelineGroupRenderer
                        key={`${message.id}-${index}`}
                        group={group}
                        groupKey={`${message.id}-${index}`}
                        skipAnimation={suppressAnim}
                      />
                    ))}
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

          {liveTimelineGroups.map((group, index) => (
            <TimelineGroupRenderer
              key={`live-${index}`}
              group={group}
              groupKey={`live-${index}`}
            />
          ))}

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
