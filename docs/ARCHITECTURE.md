# deskmates architecture

Status: draft v0.1, from the `ecc:architect` agent's design, reconciled with `SECURITY.md` and `DESIGN.md`. Not yet reviewed by the owner.

## Core idea: event sourcing

Each provider turns raw agent logs into **normalized events**. One **pure reducer** turns events into office state. The same reducer runs on the server, in the browser and in replay, so live view, reconnect and replay behave identically.

## Components and process boundaries

```
[Claude Code procs] --append--> ~/.claude/projects/**.jsonl
        |  (optional, consented) hook command --HTTP POST 127.0.0.1 + token--+
        v                                                                    |
+--------------------- deskmates Node process (127.0.0.1) ---------------+   |
| Watcher (fs.watch + byte offsets) -> Provider(claude).parseLine()      |   |
|     -> NormalizedEvent stream -> EventBus (seq#) <-- HookIngress <------+---+
|     -> core.reduce() -> OfficeState          -> Recorder (.dmrec)      |
|     -> WS hub (snapshot + delta batches) <- decisions (allow / deny)   |
+---------------------------|--------------------------------------------+
                            v  ws://127.0.0.1:PORT/?t=<launch token>
[Browser] core.reduce() mirror -> Sim (seeded animation) -> Canvas 2D renderer
          Needs-you queue, stats panel, replay scrubber, clip export
```

- The PermissionRequest hook command blocks for up to N seconds waiting for a decision. If the server is down, the token is missing or it times out, it exits 0 with no decision, so Claude Code falls back to its own prompt. deskmates must never be able to wedge a session.
- Without hooks, "Needs you" uses a heuristic (a `tool_use` with no `tool_result` after N seconds, default 8). In that mode the only action is "jump to terminal". Approve and deny require hooks. The UI says this plainly.

## Verified input facts (Claude Code transcripts)

- `~/.claude/projects/<project-dir>/<sessionId>.jsonl`, one JSON object per line. Top-level keys include `type` (user, assistant, system, attachment, and metadata kinds), `sessionId`, `cwd`, `timestamp`, `isSidechain`, `gitBranch`, `version`, `uuid`, `parentUuid`.
- Assistant lines: `message.content` blocks `thinking`, `text`, `tool_use {id,name,input}`; `message.usage` has `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`; `message.model`.
- User lines carry `tool_result {tool_use_id, content, is_error}`.
- Subagents: `<sessionId>/subagents/agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`); lines have `isSidechain: true` and `agentId`.
- Transcripts do not record "waiting for permission".

## Event model and provider interface (`packages/core`)

```ts
type AgentRef = { provider: string; sessionId: string; agentId?: string; parentAgentId?: string };
type Base = { seq: number; ts: number; agent: AgentRef };
type NormalizedEvent = Base & (
  | { kind: 'session.start'; cwd: string; gitBranch?: string; title?: string; model?: string }
  | { kind: 'agent.spawn'; agentType?: string; description?: string; viaToolUseId?: string; depth: number }
  | { kind: 'agent.end'; reason: 'stop' | 'idle' | 'error' }
  | { kind: 'activity'; state: 'thinking' | 'typing' | 'reading' | 'editing' | 'running' | 'searching' | 'idle' }
  | { kind: 'tool.start'; toolUseId: string; name: string; summary: string }   // summary is redactable
  | { kind: 'tool.end'; toolUseId: string; isError: boolean }
  | { kind: 'attention'; toolUseId: string; source: 'heuristic' | 'hook'; requestId?: string }
  | { kind: 'attention.resolved'; toolUseId: string; decision?: 'allow' | 'deny' }
  | { kind: 'usage'; model: string; input: number; cacheWrite: number; cacheRead: number; output: number }
  | { kind: 'message'; role: 'user' | 'assistant'; chars: number });

interface Provider {
  id: string;
  discover(): AsyncIterable<SourceRef>;
  watchRoots(): string[];
  parseLine(src: SourceRef, line: string, ctx: ParseCtx): NormalizedEvent[];   // pure, sync, never throws
  hooks?: { install(dryRun: boolean): Diff; uninstall(): Diff; ingest(body: unknown): NormalizedEvent[] };
  focusTerminal?(agent: AgentRef): Promise<boolean>;
}
```

- Tool name to activity is a per-provider table (Read, Grep, Glob -> reading; Edit, Write, NotebookEdit -> editing; Bash -> running; WebSearch, WebFetch -> searching).
- Cost is never an event. It is derived from `usage` and a price table. Unknown models show tokens only and mark the total with `+`.

### Cost estimates and prices

Costs are **estimates**: tokens x USD per million tokens. The HUD shows `~$X`, and `est.` when the built-in table is used.

- **Built-in table.** `DEFAULT_PRICES` in `packages/core/src/prices.ts` holds the Claude models (Fable, Mythos, Opus, Sonnet, Haiku) with input, 5-minute cache write, cache read and output prices. It is dated by `PRICES_AS_OF` (currently 2026-10-18). `claude-haiku-5-5` uses the up-to-100K-prompt tier; the higher long-prompt tier is not modeled.
- **Model ids** are normalized before lookup (`normalizeModelId`): lowercased, trailing `[1m]`-style suffix and trailing `-YYYYMMDD` date removed. So `claude-sonnet-4-5-20250929` prices as `claude-sonnet-4-5`. Unknown ids (and `<synthetic>`) are cost unknown.
- **Override.** Create `~/.deskmates/prices.json`, keyed by normalized model id:

  ```json
  { "claude-sonnet-4-5": { "inputPerMTok": 3, "cacheWritePerMTok": 3.75, "cacheReadPerMTok": 0.3, "outputPerMTok": 15 } }
  ```

  The file is **merged over** the built-in table: your entry wins for that model, every other model keeps its built-in price, and you can add models the table lacks. All four numbers must be 0 to 1,000,000; one bad entry, bad JSON or a file over 256 KB ignores the whole file (built-ins are used, a warning code is logged). The HUD then says "Estimated from your prices.json".
- **Source reported to the client.** Snapshots carry `pricesSource` (`default` | `user` | `example`) and `pricesAsOf`; `/api/status` reports `pricesSource`. `example` is only the demo and tests.
- **Refreshing the table.** Re-read https://platform.claude.com/docs/en/about-claude/pricing, update `DEFAULT_PRICES` and `PRICES_AS_OF` in `packages/core/src/prices.ts` (the core tests check key normalization and spot prices), and update the date above.
- Agents are keyed by (file path, sessionId, agentId), never by sessionId alone.

## State store and transport

- `reduce(state, event) => state`. State is a plain serializable object keyed by agent key. No timers inside. Time-based rules (heuristic, idle) run in a server ticker that emits events. Wall-clock time never enters the reducer.
- WebSocket: on connect the server sends `{snapshot, seq}`, then `{events[]}` batches at most 10 Hz. On a seq gap the client asks for a fresh snapshot.
- Client to server: `decide{requestId, allow|deny}`, `focus{agent}`, `subscribe{filter}`.
- Runtime dependency: `ws` only. Dev: Vite, Vitest, Playwright.

## Replay

- `.dmrec` = gzipped NDJSON. Line 1 header `{format:'dmrec', v:1, provider, createdAt, redaction:'summaries'|'none', seed}`. Following lines are NormalizedEvents with `ts` relative to start.
- Deterministic: pure reducer, animation PRNG seeded from `hash(seed, agentKey)`, simulation on a fixed timestep driven by event `ts`, not `Date.now()`.
- Scrubber: snapshot every 500 events; seek = restore nearest snapshot, re-reduce forward.
- Export: sliced `.dmrec` (redacted by default; drops tool summaries and paths) and WebM via `canvas.captureStream` + `MediaRecorder`, no extra dependency.

## Monorepo layout (pnpm workspaces)

```
packages/core/            events.ts reduce.ts selectors.ts prices.ts layout.ts
packages/provider-claude/ parse.ts discover.ts hooks.ts fixtures/
packages/server/          watch.ts bus.ts ws.ts hookIngress.ts recorder.ts ticker.ts
packages/client/          sim/ render/ ui/ replay/
packages/sprites/         procedural generator (seeded palette, body/hair/desk parts)
apps/cli/                 bin deskmates (start | hooks install|uninstall | replay <file>)
docs/adr/
```

## Testing

- Parser: real-shaped scrubbed or synthetic JSONL fixtures mapped to golden event arrays. Cover truncated last line, unknown `type`, orphan `tool_result`, missing subagent meta, version drift.
- Reducer: property tests (any batch split gives the same final state) plus golden snapshots.
- Simulation: replay a `.dmrec` headless; hash state and sprite positions at fixed ticks; same input must give the same hash.
- Sprites: same seed gives same pixel hash.
- UI: Playwright against a fake server streaming a fixture; screenshot diffs at fixed ticks; approve/deny flow against a stub hook.
- Security: the DNS-rebinding and Origin/token tests in `SECURITY.md` run in CI.

## Performance

- Tail from a per-file byte offset with a partial-line buffer; parse lazily; extract only `type`, content block kinds and `usage`.
- Cold start on 10,000+ line files is one streamed pass, cached in `~/.deskmates/cache/<file>.json` (offset + reduced state).
- Sessions with mtime older than 30 minutes show as "away" and are not tailed; a directory watch revives them.
- Watch directories, not one watcher per file. Batch at 10 Hz. Animation runs only in the client.
- Canvas: offscreen sprite atlas, dirty-rect redraw, cap about 200 visible characters, overflow rooms virtualized.
- Budget: 50 live sessions under 5% CPU and 150 MB RSS, with a benchmark script.

## ADRs to write, in order

1. Event sourcing with one pure shared reducer
2. Normalized event schema and versioning
3. Provider interface
4. Passive watching first; hooks opt-in with consent, dry-run diff and uninstall
5. Permission-decision protocol and fail-open timeout
6. Local-only security model (bind, token, Origin, no telemetry)
7. WebSocket snapshot-plus-delta protocol
8. `.dmrec` format and redaction defaults
9. Procedural sprite generation, no third-party art
10. Pricing table and cost derivation
11. Dependency policy
12. Terminal-focus strategy per OS and terminal

## Evolution

- Desktop: wrap server and client in Electron (Node server in the main process); tray icon with Needs-you count and native notifications. Tauri only if bundle size matters (needs a Node sidecar).
- Layout editor: layout is JSON data in `core` from day one (rooms, desks, assignment rules such as "by cwd"); the editor is a client mode.
- Terminal mode: a TUI renderer subscribing to the same WebSocket protocol.
- Team/LAN: separate opt-in `--share` relay with explicit bind flag, pairing code and TLS; only redacted events (activity, attention, usage); remote approve and deny disabled unless the host allows it per peer. Do not reuse the localhost token model.

## Open points

- Jump-to-terminal is best effort: osascript for iTerm and Terminal.app, tmux where it applies, otherwise a notification.
- The 8-second heuristic will misfire on long Bash runs; tune per tool and allowlist long-running tools.
- Do not build the provider abstraction beyond the interface until a second provider exists.
