# OpenVibez Robustness Proposals (Provider-Aware, Low-Debt)

## 1) Goal and guardrails

Goal: improve reliability, correctness, and operational safety of chat/tool execution without adding framework-heavy technical debt.

Guardrails for adoption:

- Prefer provider-native protocols/SDKs over custom protocol parsers.
- Prefer incremental refactors behind stable internal interfaces.
- Avoid broad framework migrations unless they replace substantial bespoke logic.
- Keep feature parity for current UX (streaming traces, cancel, workspace modes).

## 2) Where we are currently fragile

From current implementation (`apps/desktop/src/main/ipc/chat.ts`, `providers/*.ts`):

- Main orchestration is monolithic (provider routing + tool loop + shell + persistence).
- OpenAI SSE parsing is hand-rolled.
- Local/Ollama tool loop depends on text protocol (`PLAN/TOOL_CALL/STEP_DONE/FINAL`) rather than native tool calls.
- Access mode/trust are advisory in local shell path (not hard enforcement).
- Run state is mostly in-memory (`inflightRequests`) and stream events; crash recovery is limited.

## 3) Existing provider solutions we can leverage

## OpenAI API / SDK

- Official `openai` Node SDK supports Responses API streaming, retries, timeout config, request IDs, and typed errors.
- OpenAI docs provide a first-class function/tool-calling flow with JSON schema and strict tool controls.
- Responses API supports stateful continuation via `previous_response_id` and Conversations API.
- Background mode + webhooks can support durable long-running runs and reconnect-safe completion.

## Codex stack

- Codex CLI already supports sandbox modes and non-interactive automation.
- Codex docs expose MCP server mode and approval-policy controls (`untrusted`, `on-failure`, `on-request`, `never`).
- Codex GitHub Action demonstrates hardened execution patterns (privilege reduction, schema output, explicit safety strategy).
- OpenAI announced Codex SDK (TypeScript) with structured outputs + built-in session context management.

## Ollama

- Ollama officially supports tool calling (single, parallel, multi-turn loops, streaming tool calls).
- Official Ollama JS SDK supports `stream: true` AsyncGenerator and tool definitions in `chat()`.
- Ollama streaming docs explicitly describe handling streamed `tool_calls` and `thinking` fields.

## 4) Proposal matrix (weighted for low debt)

Scoring:
- Robustness Gain: Low/Med/High
- Implementation Cost: Low/Med/High
- Debt Risk: Low/Med/High

| Proposal | Robustness Gain | Cost | Debt Risk | Recommendation |
|---|---|---|---|---|
| A. Introduce `ProviderRunner` interface and split `chat.ts` orchestration | High | Med | Low | Do now |
| B. Move OpenAI path to official SDK streaming primitives | High | Low-Med | Low | Do now |
| C. Add run journal table (`assistant_runs` + event checkpoints) for crash recovery | High | Med | Low-Med | Do now |
| D. Enforce workspace/trust policy at command executor boundary | High | Med | Low | Do now |
| E. Add idempotency + exactly-once-ish write guards for send/cancel | Med-High | Med | Low | Do now |
| F. Add background-mode/webhook path for long OpenAI runs | Med-High | Med | Med | Pilot behind flag |
| G. Replace Ollama text protocol with native tool calling when supported | High | Med | Low-Med | Do next |
| H. Keep text protocol fallback for non-tool-capable local models | Med | Low | Low | Keep |
| I. Add Codex approval-policy + schema output controls to integration | Med-High | Low-Med | Low | Do next |
| J. Evaluate Codex SDK migration from CLI wrapper | Med-High | Med-High | Med | Pilot only |
| K. Adopt large orchestration framework (LangChain-like) | Variable | High | High | Avoid for now |

## 5) Detailed proposals

## A) Split orchestration into stable runners

Current pain:
- `message:send` mixes transport, provider policy, tool loop, stream mapping, and persistence.

Change:
- Introduce `ProviderRunner` contract with normalized events:
  - `status`
  - `trace`
  - `delta`
  - `done`
  - `error`
- Implement runners:
  - `OpenAIRunner`
  - `CodexRunner`
  - `OllamaRunner`
- Keep `chat.ts` as coordinator only (session context + persistence + cancellation registry).

Pros:
- Easier provider-specific hardening.
- Testability improves (contract tests per runner).
- Lower blast radius for future changes.

Cons:
- Requires refactor of existing control flow.

Debt risk:
- Low (architectural simplification).

## B) OpenAI: adopt official SDK end-to-end

Current pain:
- Manual SSE parser in `providers/openai.ts`.

Change:
- Use official OpenAI Node SDK stream iteration for Responses events.
- Keep event mapping in one place.
- Standardize retries/timeouts via SDK configuration.
- Persist `_request_id` for diagnostics.

Pros:
- Removes brittle parser code.
- Aligns with evolving event schemas.
- Better operational debugging with request IDs.

Cons:
- Dependency behavior changes must be version-pinned and tested.

Debt risk:
- Low (replace custom plumbing with official client).

## C) Durable run journal

Current pain:
- Inflight state and partial stream are mostly process-memory.

Change:
- Add `assistant_runs` table with:
  - run id, session id, provider id, status, started/updated/completed time
  - stream cursor/sequence
  - cancellation requested flag
  - last provider response id (if applicable)
- Add optional `assistant_run_events` for replay/debug.

Pros:
- Crash recovery and better cancel semantics.
- Enables deterministic "resume or reconcile" on app restart.

Cons:
- Extra schema and retention policy work.

Debt risk:
- Low-Med (worth it for reliability).

## D) Command policy enforcement (hard, not advisory)

Current pain:
- Workspace trust/access mode are not strict in local shell path.

Change:
- Add mandatory command guard before `spawn`:
  - deny `danger-full-access` unless explicit mode + trusted workspace
  - enforce cwd under workspace for scoped mode
  - optional denylist for high-risk commands
- For untrusted/read-only workspaces: reject mutating commands.

Pros:
- Turns policy intent into enforceable behavior.
- Reduces accidental destructive execution.

Cons:
- Requires precise command classification logic.

Debt risk:
- Low if implemented as a small, testable policy module.

## E) Idempotency and exactly-once-ish persistence

Current pain:
- Possible duplicate writes around retries/cancel race windows.

Change:
- Add send id (`client_message_id`) and uniqueness guard per session.
- Separate assistant draft row from final row state transitions.
- Ensure cancellation marks run state first, then finalizes persisted output once.

Pros:
- Prevents duplicated assistant/user rows in edge retries.
- Cleaner state for UI after races.

Cons:
- More state transitions to model.

Debt risk:
- Low.

## F) OpenAI background mode + webhooks (flagged)

Current pain:
- Long runs depend on live stream continuity.

Change:
- For long-running models/tasks, opt-in to `background=true` with polling/webhook completion path.
- Use webhooks with signature verification for external completion events.

Pros:
- More resilient to transient connectivity and renderer restarts.
- Better long-task reliability.

Cons:
- More moving parts.
- Data retention tradeoff (`background` has storage implications).

Debt risk:
- Medium; use only behind explicit feature flag.

## G) Ollama: native tool calling first

Current pain:
- Custom text protocol adds parser fragility and model-format sensitivity.

Change:
- Detect tool-capable model/profile and run native `tools` flow:
  - send tool schemas
  - consume streamed/non-streamed `tool_calls`
  - execute tool(s)
  - return tool outputs until completion
- Preserve current checklist UI by deriving trace events from native tool calls.

Pros:
- Moves from prompt protocol to provider protocol.
- Better interoperability with newer tool-capable models.

Cons:
- Need compatibility logic for models with inconsistent tool behavior.

Debt risk:
- Low-Med if fallback retained.

## H) Keep protocol fallback for weak local models

Change:
- Keep existing `PLAN/TOOL_CALL/...` path as fallback when model lacks reliable native tools.

Pros:
- Backward compatibility.
- Avoids forcing users onto specific local models.

Cons:
- Two execution paths to maintain.

Debt risk:
- Low if code paths share the same command-policy and persistence infrastructure.

## I) Codex integration hardening (without full rewrite)

Change:
- Expose approval-policy and sandbox controls in session/provider config.
- Add schema-constrained output mode when task expects structured result.
- Add richer error mapping from codex JSON events and exit status.

Pros:
- Better safety posture.
- More deterministic automation outputs.

Cons:
- UI/options surface becomes broader.

Debt risk:
- Low-Med.

## J) Codex SDK migration (pilot only)

Change:
- Pilot replacing CLI subprocess path with Codex SDK for one narrow workflow.

Pros:
- Could reduce subprocess parsing burden.
- Potentially better native thread/session abstractions.

Cons:
- New dependency and lifecycle semantics.
- Unknown parity vs current CLI event stream in desktop context.

Debt risk:
- Medium; do only with strict exit criteria.

## 6) Recommended phased plan

## Phase 1 (highest ROI, lowest debt)

1. Extract `ProviderRunner` interface and split monolith.
2. Move OpenAI to official SDK event handling.
3. Add command-policy enforcement + trust-level gating.
4. Add send/run idempotency guards.

## Phase 2

1. Add durable run journal + restart reconciliation.
2. Add Codex approval-policy/schema options.
3. Implement Ollama native tool-calling path with fallback.

## Phase 3 (optional / flagged)

1. Background-mode + webhook path for OpenAI long jobs.
2. Codex SDK pilot; keep CLI integration as default until parity proven.

## 7) What we should explicitly avoid (for debt control)

- Full framework migration of agent runtime before runner modularization.
- Replacing all providers simultaneously in one release.
- Removing fallback paths before model capability detection is robust.
- Adding many new tools before policy enforcement and run journaling are in place.

## 8) Suggested acceptance criteria per proposal

For every adopted proposal, require:

- Integration tests for send/cancel/retry races.
- Restart recovery tests (mid-stream crash).
- Provider contract tests (status/trace/delta ordering + finalization).
- Security tests for scoped vs root and trust-level constraints.
- Regression tests for UI timeline rendering.

## 9) Source notes (external capabilities checked)

- OpenAI Function Calling guide (tool flow, schema, tool choice controls):
  - https://developers.openai.com/api/docs/guides/function-calling
- OpenAI Streaming Responses guide (semantic events, lifecycle events, moderation note):
  - https://developers.openai.com/api/docs/guides/streaming-responses
- OpenAI Conversation State guide (`previous_response_id`, Conversations API):
  - https://developers.openai.com/api/docs/guides/conversation-state
- OpenAI Background Mode guide (async runs, polling/cancel, limits):
  - https://developers.openai.com/api/docs/guides/background
- OpenAI Webhooks guide (signature verification + `response.completed` flow):
  - https://developers.openai.com/api/docs/guides/webhooks
- OpenAI Node SDK README (official JS/TS client, retries/timeouts/request IDs):
  - https://github.com/openai/openai-node
- Codex GA announcement (Codex SDK availability and capabilities):
  - https://openai.com/index/codex-now-generally-available/
- Codex CLI docs in repo (MCP server, approval policy options):
  - https://github.com/openai/codex
- Codex GitHub Action (safety strategy, sandbox, schema output patterns):
  - https://github.com/openai/codex-action
- Ollama capabilities (tool calling + streaming semantics):
  - https://docs.ollama.com/capabilities/tool-calling
  - https://docs.ollama.com/capabilities/streaming
- Ollama official JS library:
  - https://github.com/ollama/ollama-js

