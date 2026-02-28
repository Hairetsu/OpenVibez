# OpenVibez Chat Surface Spec

## Purpose

This document defines the product-level contract for chat messages, streamed text, traces, code/tool activity, and the roadmap for the chat surface.

It is intentionally higher level than [docs/LOW_LEVEL_ARCHITECTURE.md](/Users/thomaswhidden/Projects/OpenVibez/docs/LOW_LEVEL_ARCHITECTURE.md). The goal here is to describe what the UI should show and what the app should persist, not every internal implementation detail.

## Scope

This spec covers:

- persisted chat messages
- streamed run events
- trace semantics
- code and command presentation
- tool-call UX expectations
- near-term roadmap for chat UX

This spec does not cover:

- provider auth/setup UX
- database schema in full
- packaging or distribution

## Core Principles

- Chat is the primary surface for coding work.
- The assistant should show both the final answer and enough execution context to be trustworthy.
- Tool activity should be visible, but not overwhelm the final response.
- Markdown and code should render cleanly by default.
- Provider-specific execution details should normalize into one UI model where possible.

## Data Model

### Persisted message

Messages are stored per session and represent durable conversation history.

Current message roles:

- `system`
- `user`
- `assistant`
- `tool`

Current persisted message shape, aligned to preload types:

```ts
type Message = {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  contentFormat: string;
  toolName: string | null;
  toolCallId: string | null;
  seq: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicrounits: number | null;
  createdAt: number;
};
```

### Stream event

During a live run, the main process emits stream events to the renderer.

Current stream event types:

- `status`
- `trace`
- `text_delta`
- `error`
- `done`

Current event shape:

```ts
type MessageStreamEvent = {
  streamId: string;
  sessionId: string;
  type: "status" | "trace" | "text_delta" | "error" | "done";
  text?: string;
  trace?: MessageStreamTrace;
};
```

### Trace

Traces are not final chat messages. They are structured execution breadcrumbs shown inline during and after a run.

Current trace kinds:

- `thought`
- `plan`
- `action`

Current action kinds:

- `file-edit`
- `file-read`
- `file-create`
- `file-delete`
- `search`
- `command`
- `command-result`
- `generic`

Shape:

```ts
type MessageStreamTrace = {
  traceKind: "thought" | "plan" | "action";
  text: string;
  actionKind?: ActionKind;
};
```

## Chat Output Layers

Each run can produce three parallel layers of output:

### 1. Final assistant response

This is the user-facing answer.

Requirements:

- persisted as an `assistant` message
- rendered as markdown
- should remain readable even if traces are hidden
- may include code blocks, file references, summaries, next steps

### 2. Live text stream

This is incremental prose shown before the final assistant message is committed.

Requirements:

- append in order via `text_delta`
- merge into a single visible live response block while streaming
- persist only once the run finishes or errors out

### 3. Trace/timeline activity

This is execution context.

Requirements:

- visible inline during a run
- persisted separately as session timeline state
- grouped semantically in the renderer
- should explain what the assistant did, not replace the final answer

## Rendering Rules

### Markdown

Assistant and user text should support:

- paragraphs
- lists
- tables
- blockquotes
- links
- fenced code blocks
- inline code

Current renderer uses:

- `react-markdown`
- `remark-gfm`
- `rehype-highlight`

### Code blocks

Code is part of normal markdown output, not a separate message type.

Requirements:

- syntax highlighting on fenced code blocks
- preserve whitespace and line breaks
- keep code readable in long responses
- support future copy/apply actions

Current state:

- syntax highlighting exists
- copy/apply actions are not built yet

### File references

The UI should recognize likely file references inside assistant text and traces.

Current behavior includes parsing patterns such as:

- `path/to/file.ts`
- `./relative/path.ts`
- `/absolute/path.ts`
- file references with line/column suffixes

This is currently used mostly for summarizing actions rather than clickable deep file UX.

### Tool and command activity

Commands should not appear as raw transcript spam when they can be summarized.

Current renderer behavior:

- command traces are summarized as commands
- command results are summarized as exit/stdout/stderr
- file-edit style traces attempt to summarize added/removed files
- search-like traces are grouped as exploration
- checklist traces render as step progress

## Timeline Semantics

The renderer stores an interleaved timeline of:

- `run_marker`
- `trace`
- `text`

Goals:

- preserve the order of what happened during a run
- allow the UI to reconstruct execution after restart
- keep final prose and tool actions visually separable

Timeline grouping rules:

- `thought` is contextual and may be displayed as lightweight state
- `plan` updates should read like a checklist or completion state
- `action` should represent concrete work: commands, searches, file operations, tool results
- trailing action events should render before final prose if event delivery arrives slightly out of order

## Tool Call UX Contract

The UI does not currently expose provider-native tool payloads directly. Instead, tools normalize into traces and final output.

### Supported visible tool categories

- shell command execution
- command output/result
- file reads
- file edits / creates / deletes
- search / exploration
- checklist progress

### Shell command contract

When an agent executes a command, the user should be able to infer:

- what command ran
- where it ran (`cwd`)
- whether it succeeded
- whether it timed out
- the important output or error

Current trace format already supports this with:

- command trace
- command-result trace

### Provider differences

Providers may reach the same UI contract differently:

- OpenAI/Codex can emit more native structured event streams
- Grok uses a constrained tool protocol with shell execution
- Anthropic now supports native tool use first, then protocol fallback
- Ollama uses native tools where possible, protocol fallback otherwise

Product rule:

- provider differences should be normalized before they reach the renderer whenever practical

## Session and Run Behavior

### Session

A session is the durable conversation container.

Each session currently has:

- one active provider
- one selected model
- one optional workspace

### Run

A run is a single assistant execution started by a user message.

A run should support:

- start status
- live streaming
- traces
- cancellation
- durable completion or recovery

Current behavior:

- user message is persisted immediately
- stream events drive the live UI
- assistant message is persisted at completion
- interrupted runs are reconciled on restart

## What The Chat Surface Should Show

For a normal coding task, the ideal visible order is:

1. user prompt
2. status indicator
3. plan/checklist traces if applicable
4. action traces as real work happens
5. streamed final answer
6. persisted final assistant message

For a simple non-tool question, the ideal visible order is:

1. user prompt
2. short status
3. streamed answer
4. final persisted assistant answer

## Non-Goals

The chat surface should not:

- dump raw provider protocol noise
- expose unreadable tool payloads directly to the user
- show duplicate final content and trace content without grouping
- require the user to parse stderr/stdout walls for every task

## Current Gaps

These are known product gaps, not necessarily backend blockers.

- code block copy/apply actions are missing
- file references are not consistently clickable/openable
- trace density can still feel noisy for long runs
- tool results are summarized heuristically rather than through a single canonical action schema
- session branching and message-level forks are not implemented
- search/filter over conversation history is not implemented
- per-message artifact handling is not implemented

## Roadmap

### Phase 1: Chat clarity

- standardize trace cards for command, result, file edit, and search
- add copy actions for code blocks and commands
- improve clickable file/path references
- tighten final-answer vs trace separation in the feed

### Phase 2: Tool UX

- introduce a normalized internal action schema for tool output
- render file edits as structured file change summaries instead of raw patch text where possible
- add explicit tool result states: running, success, failed, blocked
- show better progress for multi-step agent runs

### Phase 3: Code workflows

- apply-to-file actions from assistant code blocks
- diff previews before writes when applicable
- richer artifact blocks for generated files, patches, and reports
- fork session from message / branch conversation

### Phase 4: Search and memory

- conversation search and filtering
- run-level indexing of final answers vs trace history
- better workspace recall and context surfacing

## Future Schema Direction

Likely future additions:

- explicit `artifact` concept for code outputs, patches, and generated files
- normalized trace/action payloads beyond plain text
- richer message content blocks instead of a single markdown string
- durable run events table rather than settings-backed timeline only

## Reference Files

Current implementation relevant to this spec:

- [apps/desktop/src/preload/types.ts](/Users/thomaswhidden/Projects/OpenVibez/apps/desktop/src/preload/types.ts)
- [apps/desktop/src/renderer/features/chat/MessageList.tsx](/Users/thomaswhidden/Projects/OpenVibez/apps/desktop/src/renderer/features/chat/MessageList.tsx)
- [apps/desktop/src/renderer/features/chat/chat.store.ts](/Users/thomaswhidden/Projects/OpenVibez/apps/desktop/src/renderer/features/chat/chat.store.ts)
- [apps/desktop/src/main/ipc/chat.ts](/Users/thomaswhidden/Projects/OpenVibez/apps/desktop/src/main/ipc/chat.ts)
- [apps/desktop/src/main/services/runners/](/Users/thomaswhidden/Projects/OpenVibez/apps/desktop/src/main/services/runners)
