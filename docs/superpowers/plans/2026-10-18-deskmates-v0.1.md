# deskmates v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (chosen) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local app (`deskmates`) that watches Claude Code transcripts and shows each session and subagent as an animated pixel-art character in a browser office, with tokens, cost, time and a heuristic "Needs you" queue. Read-only: no state-changing endpoints in v0.1.

**Architecture:** Event sourcing. A provider turns transcript lines into normalized events; one pure reducer in `core` builds office state; the Node server tails files, runs the reducer, and streams snapshot-plus-delta over a token-protected WebSocket; a Canvas 2D client mirrors the reducer and animates. See `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DESIGN.md`, `CAPABILITY-MAP.md`.

**Tech Stack:** TypeScript (strict), Node 20+, pnpm workspaces, Vitest, `ws` (only runtime dependency), esbuild for bundling, Canvas 2D (no UI framework).

**Plan deviation (accepted):** the writing-plans skill asks for full code in every step. At this size the plan gives exact interfaces, named test cases, commands and expected results; the implementer agent writes the code test-first. No task may commit. The owner commits.

## Global rules for every task

- TDD: write the failing test, run it and see it fail for the right reason, implement, run, see it pass.
- Stay inside the files listed for the task. If another file must change, stop and report.
- Never read private transcript content: inspect structure only. Fixtures are synthetic.
- No raw transcript text in logs, errors, UI or stored files. Tool summaries are short labels (see Task 3).
- Render any transcript-derived text as text, never as HTML.
- No new dependencies beyond those named in the plan without asking.
- Do not install hooks, edit `~/.claude/settings.json`, publish, or commit.
- Report at the end: files changed, test command and its output summary, any deviation, any open question.

## Dependency graph and execution order

```
T1 scaffold -> T2 core -> T3 provider-claude --\
                     \-> T5 sprites ------------> T6 client --\
                      \-> T4 server (needs T3) ---------------> T7 cli -> T8 integration and review gates
```
Parallel after T2: T3 and T5. After T3: T4. After T2 and T5: T6. After T4 and T6: T7. Then T8.

---

### Task 1: Scaffold the monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `README.md` (short, honest status)
- Create per package `package.json` + `tsconfig.json` + `src/index.ts` stub: `packages/core`, `packages/provider-claude`, `packages/server`, `packages/sprites`, `packages/client`, `apps/cli`

- [ ] Step 1: root `package.json` private, scripts `test` (`pnpm -r test`), `typecheck` (`pnpm -r typecheck`), `build`; `pnpm-workspace.yaml` lists `packages/*` and `apps/*`; packages named `@deskmates/<name>`, `"type": "module"`, internal deps `workspace:*`.
- [ ] Step 2: `tsconfig.base.json`: strict, `noUncheckedIndexedAccess`, target ES2022, module ESNext, moduleResolution Bundler, `skipLibCheck`.
- [ ] Step 3: dev dependencies at root: `typescript`, `vitest`, `esbuild`, `@types/node`; `ws` and `@types/ws` in `packages/server` only.
- [ ] Step 4: each package gets one trivial test (`expect(true).toBe(true)`) so `pnpm -r test` runs.
- [ ] Step 5: run `pnpm install`, `pnpm -r test`, `pnpm -r typecheck`. Expected: all pass.
- [ ] Step 6: `.gitignore` covers `node_modules`, `dist`, `.deskmates`. Do not run `git init` or commit.

### Task 2: core (events, reducer, selectors)

**Files:** `packages/core/src/{events.ts,state.ts,reduce.ts,selectors.ts,prices.ts,index.ts}`, tests `packages/core/test/{reduce.test.ts,selectors.test.ts}`

Interfaces (export all from `index.ts`):
```ts
export type AgentRef = { provider: string; sessionId: string; agentId?: string; parentAgentId?: string };
export type Activity = 'thinking' | 'typing' | 'reading' | 'editing' | 'running' | 'searching' | 'idle';
export type NormalizedEvent = { seq: number; ts: number; agent: AgentRef } & (
  | { kind: 'session.start'; cwd: string; gitBranch?: string; title?: string; model?: string }
  | { kind: 'agent.spawn'; agentType?: string; description?: string; viaToolUseId?: string; depth: number }
  | { kind: 'agent.end'; reason: 'stop' | 'idle' | 'error' }
  | { kind: 'activity'; state: Activity }
  | { kind: 'tool.start'; toolUseId: string; name: string; summary: string }
  | { kind: 'tool.end'; toolUseId: string; isError: boolean }
  | { kind: 'attention'; toolUseId: string; source: 'heuristic' | 'hook'; requestId?: string }
  | { kind: 'attention.resolved'; toolUseId: string; decision?: 'allow' | 'deny' }
  | { kind: 'usage'; model: string; input: number; cacheWrite: number; cacheRead: number; output: number }
  | { kind: 'message'; role: 'user' | 'assistant'; chars: number });
export type AgentKey = string;                 // `${provider}:${sessionId}:${agentId ?? 'main'}`
export const agentKey: (ref: AgentRef) => AgentKey;
export type AgentStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error' | 'done' | 'away';
export type AgentState = {
  key: AgentKey; ref: AgentRef; cwd?: string; title?: string; model?: string;
  status: AgentStatus; activity: Activity;
  openTools: Record<string, { name: string; summary: string; startedAt: number }>;
  currentTool?: { toolUseId: string; name: string; summary: string; startedAt: number };
  attention?: { toolUseId: string; source: 'heuristic' | 'hook'; requestId?: string; since: number };
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number };
  startedAt: number; lastEventAt: number; endedAt?: number;
  parentKey?: AgentKey; children: AgentKey[]; spawnDescription?: string; agentType?: string;
  lastError?: { toolUseId: string; at: number };
};
export type OfficeState = { agents: Record<AgentKey, AgentState>; order: AgentKey[]; seq: number };
export const emptyState: () => OfficeState;
export const reduce: (state: OfficeState, event: NormalizedEvent) => OfficeState;   // pure, returns a new object, never throws
export type PriceTable = Record<string, { inputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number; outputPerMTok: number }>;
export const costUsd: (agent: AgentState, prices: PriceTable) => number | undefined;  // undefined when the model has no price
export const needsYou: (state: OfficeState) => AgentState[];                          // agents with attention, oldest first
export const roomsByCwd: (state: OfficeState) => Record<string, AgentState[]>;
```
Reducer rules: unknown agent is created on first event of any kind (with `startedAt = ts`); `session.start` sets cwd, title, model, branch; `agent.spawn` links `parentKey` and `children`; `activity` sets activity and status (`thinking` -> thinking, `idle` -> idle, others -> working); `tool.start` adds to `openTools`, sets `currentTool`; `tool.end` removes the tool, sets `lastError` when `isError`, clears `attention` for that tool, and moves `currentTool` to the most recent remaining open tool; `attention` sets `attention` and status waiting; `attention.resolved` clears it; `usage` adds to totals and records `model`; `agent.end` sets status done (stop), idle (idle) or error and `endedAt`; every event updates `lastEventAt` and `seq`. Events with an unknown `kind` are ignored (state returned unchanged).

`prices.ts` exports `EXAMPLE_PRICES` clearly commented "EXAMPLE VALUES, verify against current pricing before relying on cost" and `loadPriceOverrides` is NOT in core (the server loads `~/.deskmates/prices.json`). Do not invent real prices; use obviously fake round numbers.

Tests (write first):
- [ ] creates an agent on first event; `agentKey` format stable.
- [ ] tool start/end lifecycle including parallel tools (two open, one ends, `currentTool` falls back).
- [ ] `tool.end` with `isError` sets `lastError`; with attention set, clears it.
- [ ] attention then resolved; `needsYou` ordering by `since`.
- [ ] usage accumulates; `costUsd` returns a number with a priced model and `undefined` without.
- [ ] spawn links parent and child; child order stable.
- [ ] unknown event kind and out-of-order `tool.end` (no matching start) do not throw and do not corrupt state.
- [ ] property test: applying events in one batch equals applying them one by one (use a small seeded generator, no new dependency).
- [ ] `reduce` does not mutate its input (deep-freeze the input in the test).
Verify: `pnpm --filter @deskmates/core test` passes; `pnpm --filter @deskmates/core typecheck` passes.

### Task 3: provider-claude (parser and discovery)

**Files:** `packages/provider-claude/src/{parse.ts,discover.ts,toolTable.ts,summary.ts,index.ts}`, fixtures `packages/provider-claude/test/fixtures/*.jsonl` (synthetic), tests `packages/provider-claude/test/{parse.test.ts,summary.test.ts,discover.test.ts}`

Interfaces:
```ts
export type SourceRef = { provider: 'claude'; filePath: string; sessionId: string; agentId?: string; isSubagent: boolean };
export type ParseCtx = { seenMessageIds: Set<string>; started: boolean; openToolIds: Set<string> };
export const newParseCtx: () => ParseCtx;
export const parseLine: (src: SourceRef, line: string, ctx: ParseCtx, now?: number) => Omit<NormalizedEvent, 'seq'>[];  // pure, sync, NEVER throws
export const discover: (opts: { root: string; maxAgeMs: number; now: number }) => Promise<SourceRef[]>;   // newest-first; reads subagent meta
export const readSubagentMeta: (metaPath: string) => Promise<{ agentType?: string; description?: string; toolUseId?: string; spawnDepth?: number } | undefined>;
export const summarize: (toolName: string, input: unknown) => string;   // short label, privacy-safe
export const toolActivity: (toolName: string) => Activity;
```
Format facts (verified structure): lines are JSON with `type`, `sessionId`, `cwd`, `timestamp` (ISO), `isSidechain`, `gitBranch`, `message.{role,id,model,content,usage}`; assistant `content` blocks `thinking`, `text`, `tool_use{id,name,input}`; user `content` is a string or blocks including `tool_result{tool_use_id,is_error}`; `usage` has `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`. The same `message.id` and `usage` can repeat across several lines: count usage once per `message.id` (use `ctx.seenMessageIds`).

Rules: first valid line emits `session.start` (cwd, branch, model if known); `thinking` block -> `activity thinking`; `text` block -> `activity typing` plus `message assistant` with `chars` only; `tool_use` -> `tool.start` plus `activity` from `toolActivity`; user `tool_result` -> `tool.end`; user string or text -> `message user` (chars only) and `activity thinking`; any other `type` -> `[]`. Time comes from the line's `timestamp` (fall back to `now`). Malformed JSON, missing fields, huge lines (over 1 MB) -> `[]`.
`toolActivity`: Read, Grep, Glob -> reading; Edit, Write, NotebookEdit -> editing; Bash -> running; WebSearch, WebFetch -> searching; Agent -> running; unknown or MCP -> running.
`summarize` privacy rules: file tools -> `Name: basename`; Bash -> `Bash: <first word of command>`; Grep/Glob -> `Name: <pattern truncated to 24>`; WebFetch -> `WebFetch: <hostname only>`; WebSearch -> `WebSearch`; Agent -> `Agent: <description truncated 30>`; anything else -> tool name. Never include more than 40 characters after the colon, never full paths, never command arguments or URLs with paths/query.

Tests (write first, with synthetic fixtures):
- [ ] a full assistant/user exchange maps to the expected event array (golden).
- [ ] truncated last line, invalid JSON, empty line, unknown `type`, extra unknown fields all return `[]` or ignore fields, never throw (also fuzz 200 random mutations of a valid line).
- [ ] usage counted once for repeated `message.id`.
- [ ] orphan `tool_result` still emits `tool.end`.
- [ ] `summarize` redacts: `Bash` with `curl -H "Authorization: Bearer abc" ...` yields `Bash: curl`; `Read` of `/Users/x/.env` yields `Read: .env`; `WebFetch` with `https://a.com/p?token=1` yields `WebFetch: a.com`.
- [ ] `discover` finds sessions and `subagents/agent-*.jsonl` in a temp dir, ignores files older than `maxAgeMs`, reads `.meta.json`, tolerates a missing meta.
Verify: `pnpm --filter @deskmates/provider-claude test` and typecheck pass.

### Task 4: server (watch, bus, ticker, WebSocket, static)

**Files:** `packages/server/src/{tail.ts,bus.ts,ticker.ts,security.ts,ws.ts,http.ts,server.ts,prices.ts,index.ts}`, tests `packages/server/test/*.test.ts`

Interfaces:
```ts
export type TailEvent = { src: SourceRef; line: string };
export class Tailer { constructor(opts: { onLine(e: TailEvent): void; pollMs?: number; maxLineBytes?: number }); add(src: SourceRef): void; poll(): Promise<void>; stop(): void }
export class EventBus { publish(e: Omit<NormalizedEvent,'seq'>): NormalizedEvent; since(seq: number): NormalizedEvent[] | 'gap'; state(): OfficeState; subscribe(fn: (e: NormalizedEvent) => void): () => void }
export const startTicker: (opts: { bus: EventBus; now: () => number; attentionAfterMs: (toolName: string) => number; awayAfterMs: number; intervalMs: number }) => () => void;
export const checkRequest: (req: { host?: string; origin?: string; token?: string }, ctx: { port: number; token: string }) => { ok: true } | { ok: false; status: 400 | 401 | 403; reason: string };
export const startServer: (opts: { port: number; host?: '127.0.0.1'; token: string; claudeRoot: string; clientDir?: string; now?: () => number }) => Promise<{ port: number; close(): Promise<void> }>;
```
Rules:
- `Tailer`: per-file byte offset keyed by inode plus size; read only appended bytes; buffer until newline; if the file shrank, re-read from 0; if deleted, drop it; lines over `maxLineBytes` (default 1 MB) are skipped; first sight of an existing file starts at 0 only for files modified within the last 10 minutes, otherwise at end (older history is summarized later).
- Ticker: for each agent with an open tool older than `attentionAfterMs(name)` (default 8000; `Bash` 60000; `Agent` never) and no attention, publish `attention` source `heuristic`; for agents with no events for `awayAfterMs` (default 30 minutes) publish `agent.end` reason idle. The heuristic is labeled "maybe waiting" in the UI; never notify from it alone.
- Security (`SECURITY.md` risk 1, 12): bind 127.0.0.1 only; `checkRequest` rejects a Host that is not exactly `localhost:PORT` or `127.0.0.1:PORT` (403), a present Origin that is not `http://localhost:PORT` or `http://127.0.0.1:PORT` (403), and a missing or wrong token (401) using a constant-time compare. Applies to HTTP and the WebSocket upgrade. The token is accepted from the WS subprotocol or query for the upgrade and from `Authorization: Bearer` for HTTP API calls; the static page is served only with a valid token in the URL and then keeps it in memory. Add `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:PORT ws://localhost:PORT; style-src 'self'; img-src 'self' data:` and `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- WebSocket: on connect send `{type:'snapshot', seq, state}`; then `{type:'events', events}` batches at most every 100 ms; the client may send `{type:'resync'}` to get a fresh snapshot. No other client messages are honored in v0.1.
- Prices: load `~/.deskmates/prices.json` if present (invalid file -> ignore with one warning), else `EXAMPLE_PRICES` from core; the snapshot includes `prices` and a `pricesAreExample` flag.
- No network calls. No telemetry.

Tests (write first):
- [ ] Tailer: line appended in three chunks emits once; two lines in one chunk emit twice; truncate re-reads; delete drops; oversized line skipped; partial last line not emitted until newline.
- [ ] Ticker with a fake clock: attention fires after threshold, not for `Agent`, uses the `Bash` threshold; away fires after the idle window.
- [ ] `checkRequest` table: valid; wrong Host; `Host: evil.com:PORT`; DNS-rebind Host `127.0.0.1.evil.com`; Origin `https://evil.com`; missing token; wrong token; same-length wrong token; form-encoded POST to any path gets 405.
- [ ] Integration: start the server on port 0 with a temp claude root; fetch `/` without token -> 401; with token -> 200 and CSP header; WS without token refused; WS with token receives snapshot; append a transcript line and receive an `events` batch with a `tool.start`.
- [ ] `since` returns `'gap'` when the requested seq is older than the buffer.
Verify: `pnpm --filter @deskmates/server test` and typecheck pass.

### Task 5: sprites (procedural characters)

**Files:** `packages/sprites/src/{hash.ts,palette.ts,parts.ts,generate.ts,index.ts}`, tests `packages/sprites/test/*.test.ts`

Interfaces:
```ts
export const cyrb53: (s: string, seed?: number) => number;
export const mulberry32: (seed: number) => () => number;
export type Anim = 'walk' | 'idle' | 'sit' | 'type' | 'read' | 'think' | 'celebrate' | 'error';
export type Dir = 'down' | 'up' | 'left' | 'right';
export type Frame = { width: 16; height: 24; rgba: Uint8ClampedArray };
export type SpriteSheet = { name: string; frames: Record<`${Anim}:${Dir}`, Frame[]> };
export const generateSprite: (name: string) => SpriteSheet;   // pure and deterministic
export const frameCounts: Record<Anim, number>;                // walk 4, idle 2, sit 1, type 2, read 2, think 3, celebrate 4, error 3
export const hashSheet: (sheet: SpriteSheet) => string;
```
Rules (see `docs/DESIGN.md`): 16x24; slots from the seeded PRNG: body (3), skin ramp (8), hair style (10), hair ramp (10), outfit (6), outfit ramp (12), accessory (none, glasses, headphones, cap, scarf, mug, badge), quirk pixel; each color is a 3-step ramp (shadow = lightness -18% hue toward blue, highlight = +14% toward yellow); drawn from 1-bit string-array templates in z-order; `right` mirrors `left`; originals only, no third-party art; 1-pixel dark outline.
Tests (write first): same name gives identical hash; 200 distinct names give at least 190 distinct hashes; every frame is 16x24 with at least 30 opaque pixels; `right` equals the horizontal mirror of `left`; frame counts match `frameCounts`; no frame is fully transparent; generation of 50 sheets under 500 ms.
Verify: `pnpm --filter @deskmates/sprites test` and typecheck pass.

### Task 6: client (office renderer, simulation, HUD)

**Files:** `packages/client/src/{main.ts,net.ts,render/canvas.ts,render/room.ts,render/draw.ts,sim/zones.ts,sim/path.ts,sim/character.ts,sim/sim.ts,ui/hud.ts,ui/mirror.ts,ui/format.ts,theme.ts}`, `packages/client/index.html`, `packages/client/build.mjs` (esbuild to `dist/`), tests `packages/client/test/*.test.ts`

Rules:
- Logical 320x180 canvas, integer scale, `imageSmoothingEnabled=false`, 30 fps cap, pause when hidden (`docs/DESIGN.md`). Single room in v0.1 containing all agents (rooms per project arrive in v0.3).
- `net.ts`: connect to `ws://<host>/?t=<token>` using the token from the page URL, keep a local `core.reduce` mirror, apply `events` batches, request `resync` on a seq gap, reconnect with backoff, show "offline" state.
- `sim`: zones and tool mapping per DESIGN (Read, Grep, Glob -> bookshelf; Bash -> terminal bench; Edit, Write, NotebookEdit -> whiteboard; WebSearch, WebFetch -> web wall; Agent children enter through the door; idle -> coffee corner; attention -> bell zone), zone slots with reservation and a waiting tile, A* on a 20x11 grid with a walkable mask, minimum dwell 2 s, walk only for tools expected to last over 1.5 s (otherwise play the work animation in place), deterministic PRNG seeded per agent, fixed timestep.
- Status rings: shapes per DESIGN (working dashes, thinking dots, needs-you thick ring plus bell, error zigzag plus "!", done check, idle none), Okabe-Ito colors, night and cozy-light themes.
- HUD is real DOM: Needs-you list (labelled "maybe waiting" for heuristic source; shows the tool summary label only), agent card (name, task, current tool label, status, tokens, cost or "cost unknown", elapsed), settings (theme, reduced motion, show cost, hide file names). Transcript-derived strings use `textContent` only.
- Accessibility: canvas `aria-hidden`; a visually hidden list mirrors agents and state; `aria-live="polite"`; reduced motion honors `prefers-reduced-motion` with an override (agents move instantly with a 150 ms fade); keyboard: Tab, arrows, Enter, `N`, `Esc`, `?`; 2 px focus outline; targets at least 44 px.
Tests (write first): `path.test.ts` (A* finds shortest path, avoids blocked tiles, returns undefined when unreachable); `zones.test.ts` (tool name to zone table, slot reservation, queueing); `character.test.ts` (state machine: debounce short tools, minimum dwell, attention goes to bell, spawn enters via door); `mirror.test.ts` (hidden list text for each status; text is escaped, a name like `<img onerror=x>` appears as text); `format.test.ts` (tokens, cost, elapsed formatting; "cost unknown"); `sim.test.ts` (same events and seed give the same positions after N ticks).
Verify: `pnpm --filter @deskmates/client test`, typecheck, and `pnpm --filter @deskmates/client build` produce `dist/index.html` and `dist/app.js`.

### Task 7: cli

**Files:** `apps/cli/src/{main.ts,args.ts,token.ts,open.ts}`, `apps/cli/build.mjs`, tests `apps/cli/test/*.test.ts`

Rules: `deskmates [start]` flags `--port` (default 7878, `0` for random), `--no-open`, `--projects-dir` (default `~/.claude/projects`), `--help`, `--version`; generates a 32-byte random token per launch; prints `http://127.0.0.1:PORT/?t=TOKEN` and a one-line privacy note ("local only, nothing leaves this machine"); opens the browser unless `--no-open` (macOS `open`, Linux `xdg-open`, Windows `start`; failure to open only prints the URL); handles `SIGINT` by closing the server; exits with a clear message when the port is busy; `build.mjs` bundles to `dist/deskmates.js` with a `#!/usr/bin/env node` banner and copies `packages/client/dist` next to it. `npm` publishing is NOT part of v0.1.
Tests: arg parsing table (defaults, flags, bad port, unknown flag); token is 43 characters base64url and differs per call; smoke: spawn the built CLI with `--no-open --port 0` and a temp projects dir, read the printed URL, fetch it with a spoofed Host (expect 403) and with the real token (expect 200), then send SIGINT and expect exit 0.
Verify: `pnpm --filter deskmates test` and `pnpm --filter deskmates build` pass.

### Task 8: integration, performance and review gates

- [ ] Step 1: end-to-end test `apps/cli/test/e2e.test.ts` streaming a synthetic transcript through the real server and asserting the client mirror state via the WebSocket (no browser needed).
- [ ] Step 2: structure-only smoke against real transcripts: run the server against `~/.claude/projects`, log only counts (sessions found, events parsed, parse errors), never content.
- [ ] Step 3: benchmark script `scripts/bench.mjs`: 50 synthetic sessions appending lines for 60 s; record CPU and RSS; budget under 5% CPU and 150 MB RSS.
- [ ] Step 4: visual check with the built-in browser: open the printed URL, confirm characters render and move, screenshot.
- [ ] Step 5: review gates, each by a specialist agent given the diff and the docs: `ecc:security-reviewer` and `cto-toolkit:security-auditor` (against `SECURITY.md`), `ecc:code-reviewer` and `ecc:typescript-reviewer`, `Accessibility Auditor`, `ecc:performance-optimizer`, `ecc:silent-failure-hunter`, `Reality Checker` (evidence for "done").
- [ ] Step 6: fix confirmed findings, re-run everything, then report.

## Self-review

1. **Spec coverage:** every v0.1 module in `CAPABILITY-MAP.md` (core, ingest-claude, store inside core, server, web, cli) has a task; replay, control and export are deliberately deferred to v0.3, v0.2 and v0.4. `SECURITY.md` risks 1, 5, 7, 8, 9, 10, 11, 12 are covered by Tasks 3, 4 and 6 tests; risks 2, 3, 4, 6, 13 do not apply until hooks exist (v0.2).
2. **Placeholders:** the deliberate deviation (implementers write the code) is stated at the top; there are no TBD steps. Prices are explicitly example values.
3. **Type consistency:** `NormalizedEvent`, `AgentState`, `OfficeState`, `SourceRef`, `ParseCtx`, `EventBus` and `Frame` names are used identically across tasks.
