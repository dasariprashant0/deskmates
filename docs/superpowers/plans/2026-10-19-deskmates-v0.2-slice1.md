# deskmates v0.2 Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.2 = slice 1: consented hook install/uninstall/doctor, a hook that can only say "no opinion", a Unix-socket ingest listener, hook-based Needs-you with a read-only raw-request card, and the `/api/exchange` nonce launch flow. No approve or deny anywhere.

**Architecture:** A zero-dependency Node hook script (installed by `deskmates hooks install`) posts each `PermissionRequest` payload to a local Unix socket owned by the server, then exits 0 with empty stdout on every path. The server authenticates the socket by location, mode, ingest secret and an HMAC of a hook nonce, correlates the request to an open tool (E1, server-side, no reducer change), publishes `attention{source:'hook'}` and `session.hook` events, and pushes the raw `tool_input` live to verified read-token WebSocket connections only (R87). The client renders it as escaped text. Source of truth: `docs/v0.2/SPEC.md` (sections 5-13, requirements R1-R87), `docs/v0.2/THREAT-MODEL.md`, `docs/v0.2/spikes/*`.

**Tech Stack:** TypeScript strict, Node 20+, pnpm workspaces, Vitest, `ws` (only runtime dependency, unchanged), esbuild, Canvas 2D client. One new dev-only dependency, Playwright, in Task 12 only, and only after the owner's yes at that task.

**Plan deviation (same as the v0.1 plan, accepted):** the writing-plans skill asks for full code in every step. This plan gives exact file paths, exported interfaces, the named tests from SPEC section 12.6 with what each asserts, commands and expected results. The implementer writes the code test-first. Unlike v0.1, each task commits on the feature branch (small logical commits, PR per branch, owner merges on GitHub after CI).

## Global rules for every task

- TDD: write the failing test, run it, see it fail for the right reason, implement, run, see it pass.
- Stay inside the files listed for the task. If another file must change, stop and report.
- Never read private transcript content. Fixtures are synthetic. Never log, store or send raw `tool_input` anywhere except the R87 live push.
- The hook never emits allow or deny (R69, permanent for v0.2). Every hook failure path is exit 0 with empty stdout (R2). Never set `onFailure`.
- Render hostile text as text only (`textContent`), never HTML.
- Dependency direction per `CAPABILITY-MAP.md`: `web` talks only to the server protocol. Task 0 re-checks the new packages against it.
- **Ask first (CLAUDE.md):** adding a dependency (Task 12 only), changing the event schema (approved: OQ2, OQ3; nothing beyond), touching hook install/uninstall code (this plan is that approval's scope; real installs on the owner's machine need a separate yes), publishing, installing hooks anywhere real. Tests use temp dirs and fixture settings files only. Never touch `~/.claude/settings.json`.
- Never commit `.claude/` or `docs/HANDOFF.md`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Test commands (run in the package dir): `node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc -p . --noEmit`. Whole repo before each PR: both in every package, `node scripts/attack.mjs` (must stay green, extended in Tasks 6 and 13).
- Review gates per CLAUDE.md: `code-review-and-quality` plus `ecc:code-reviewer` on every task's diff; `ecc:security-reviewer` on Tasks 2-8; `ecc:silent-failure-hunter` on Tasks 2 and 3; final `verification-before-completion` with real command output.

## Branches and order

One branch and PR per group, merged in order, each rebased on main after the previous merge:

| Branch | Tasks |
|---|---|
| `feat/v0.2-core-schema` | 1 |
| `feat/v0.2-hook-script` | 2 |
| `feat/v0.2-ingest-listener` | 3, 4 |
| `feat/v0.2-ws-exchange` | 5, 6 |
| `feat/v0.2-installer` | 7, 8, 9 |
| `feat/v0.2-needs-you-card` | 10, 11 |
| `feat/v0.2-rebind-harness` | 12 |
| `feat/v0.2-release-prep` | 13 |

```
T0 ADRs -> T1 core -> T2 hook script --\
                   \-> T3 ingest --> T4 attention --> T5 ws --> T10 card -> T11 csp
                   T6 exchange (after T5) ------------/
T7 install engine -> T8 cli+doctor (needs T2, T3 constants) -> T9 audit
T12 harness (after T6, T10) -> T13 release prep
```
Parallel after T1: T2 and T3 and T7 (disjoint files). T4 needs T1 and T3. T8 needs T2, T3 and T7. Writers never share files.

## File map (new and changed)

- **New package `packages/hook`** (`@deskmates/hook`): `src/hook.js` (plain JS, Node builtins only, shipped as-is), `src/constants.ts` (marker, shapes), `test/` with the stub-server harness `test/stub-server.ts`.
- **New package `packages/install`** (`@deskmates/install`): pure engine, no web or server imports. `src/patch.ts` (minimal text patch of JSON/JSONC-tolerant settings), `src/scope.ts`, `src/backup.ts`, `src/atomic.ts`, `src/install.ts`, `src/uninstall.ts`, `src/doctor.ts`, `src/manifest.ts` (`install.json`), `test/fixtures/` (corpus).
- **`packages/core`**: `src/events.ts`, `src/state.ts`, `src/reduce.ts`.
- **`packages/server`**: new `src/state-dir.ts`, `src/instance-lock.ts`, `src/ingest-socket.ts`, `src/hook-attention.ts`, `src/canonical-hash.ts`, `src/request-store.ts`, `src/audit.ts`, `src/inspector-guard.ts`, `src/exchange.ts`; changed `src/security.ts`, `src/http.ts`, `src/ws.ts`, `src/server.ts`, `src/ticker.ts`.
- **`packages/client`**: new `src/net/exchange.ts`, `src/hud/needs-you-card.ts`, `src/hud/escape.ts`; changed `src/net/{protocol,connection,mirror,token}.ts`, `src/app.ts`, CSP-related build files.
- **`apps/cli`**: `src/args.ts`, `src/main.ts`, `src/bin.ts`, new `src/tty.ts`, `src/hooks-cmd.ts`, `src/doctor-cmd.ts`.
- **Private package `packages/rebind-harness`** (`@deskmates/rebind-harness`, `private: true`, excluded from `files`): Task 12.
- **Docs:** `docs/adr/`, `docs/SECURITY.md`, `README.md`, `apps/cli/README.md`.

---

### Task 0: ADRs and the coverage script

**Files:** Create `docs/adr/A1-*.md` to `A5-*.md`, `A12-*.md`, `A13-*.md` (titles per SPEC section 16), `scripts/slice1-coverage.mjs`.

- [ ] Step 1: read SPEC section 16 (ADR list) and write A1-A5, A12, A13, each: context, decision (already recorded in section 14 OQ rows), consequences. No new decisions: copy the owner's recorded answers. If a record is missing, stop and ask.
- [ ] Step 2: `scripts/slice1-coverage.mjs` reads the gate lists from SPEC section 13 (R-ids and T-names) and this plan's coverage table, and prints any id missing from either. Run: `node scripts/slice1-coverage.mjs`. Expected before the work: exit 0 for plan coverage (this plan's table is complete); it is re-run at Task 13 against the test names found by `grep -r "T-" packages/*/test apps/*/test`.
- [ ] Step 3: confirm the two new packages respect `CAPABILITY-MAP.md` (hook: no deps; install: no server/client imports; server may import neither). Note the outcome in A13 if the map needs a line.
- [ ] Step 4: commit `docs: v0.2 slice 1 ADRs and coverage script`.

### Task 1: core schema (`outcome`, `session.hook`)

**Files:** Modify `packages/core/src/{events.ts,state.ts,reduce.ts,index.ts}`; Test `packages/core/test/reduce.test.ts` (extend), `packages/core/test/hook-state.test.ts` (new).

Interfaces (additive only; no field renamed or removed):
```ts
// events.ts
export type AttentionOutcome = 'allow' | 'deny' | 'expired' | 'superseded' | 'orphaned' | 'terminal'
// 'attention.resolved' gains: outcome?: AttentionOutcome
// new kind:
| { kind: 'session.hook'; state: 'seen' | 'stale'; permissionMode?: string }
// state.ts: AgentState gains
hook?: { state: 'seen' | 'stale'; permissionMode?: string; at: number }
```
Tests (all test-first):
- `attention.resolved` with `outcome` still clears attention only when `toolUseId` matches; `recent` label for `expired`/`superseded`/`orphaned`/`terminal` is `resolved`; `allow`/`deny` labels unchanged.
- `session.hook seen` sets `hook`; `stale` keeps `permissionMode`; unknown `permissionMode` string is cleaned (`clean`, 40 chars) and never throws.
- Replay purity: reducing the same event list twice gives deep-equal state; an old server snapshot with no `hook` field reduces fine.
- `KINDS` map in `reduce.ts` includes `session.hook` (the `satisfies Record<NormalizedEvent['kind'], 1>` check fails to compile otherwise: that is the red step).

- [ ] Steps 1-4: failing test, see compile/test failure, implement, run `node node_modules/vitest/vitest.mjs run` and `tsc --noEmit` in `packages/core`. Also run `tsc --noEmit` in `packages/server` and `packages/client` (consumers). Expected: all green.
- [ ] Step 5: commit `feat(core): outcome on attention.resolved and session.hook event`.

### Task 2: the hook script and the stub-server harness (R1 slice part, R2, R3 bounds, R5, R7, R13, R60, R69)

**Files:** Create `packages/hook/{package.json,tsconfig.json,src/hook.js,src/constants.ts,src/index.ts}`, `packages/hook/test/{stub-server.ts,hook-failopen.test.ts,script-noverdict.test.ts,hook-static.test.ts,selfheal.test.ts,timing.test.ts,sigstop.test.ts,squatter.test.ts}`.

Script contract (SPEC sections 3, 6.2, 9; S1-S3 facts): reads stdin (cap 1 MiB), validates it is a JSON object with `hook_event_name === 'PermissionRequest'`, `session_id`, `tool_name`; checks `~/.deskmates/run/` owner and mode (0700) and the socket owner and mode (0600) before sending (R21); connects to the socket with a 500 ms connect timeout; sends `/v1/hello {nonce}` and verifies `mac` (HMAC-SHA-256 of `"hello"+nonce` with the ingest secret read from `ingest.json`) before sending the payload; sends `/v1/request` with `X-Deskmates-Hook`; waits at most 500 ms for the ack line (R60) and exits regardless of the answer. **In slice 1 stdout is never written, whatever the server replies.** Exit code is always 0. No `child_process`, no file writes, no `require` of anything but `node:net`, `node:fs` (read), `node:crypto`, `node:os`, `node:path`. Settings command (written by Task 7): an `sh` guard that exits 0 when the script or `node` is missing and otherwise `exec`s node, with the trailing marker comment `# deskmates:v1` (exact string fixed by S5; Task 7 owns it, Task 2 exports `HOOK_MARKER = 'deskmates:v1'`).

Stub server (`test/stub-server.ts`): a scriptable Unix-socket server with modes `ack-held`, `ack-none`, `no-ack` (accept and stay silent), `garbage`, `wrong-mac`, `close-immediately`, `slow-ack(ms)`, a stall mode for SIGSTOP, and `verdict-allow` / `verdict-deny` lines (to prove the hook ignores them).

Tests (names from SPEC 12.6):
- **T-hook-failopen:** for stdin = empty, 2 MiB, invalid JSON, wrong event name, missing `session_id`, truncated JSON, and each stub mode (including `close-immediately`, `garbage`, `wrong-mac`, socket missing, `ingest.json` missing or malformed, run dir mode 0755, socket with wrong mode): exit code 0, stdout exactly empty, finishes within 700 ms.
- **T-script-noverdict (R69):** (a) a grep test over `src/hook.js` fails if it contains `"behavior"`, an allow or deny output shape, `hookSpecificOutput`, `decision`, `updatedInput`, `updatedPermissions`, `interrupt`, or any `process.stdout`/`console.log`/`stdout.write`/fd 1 write; (b) the contract test runs the script against every stub reply, including `verdict-allow` and `verdict-deny` with a valid MAC, and asserts empty stdout and exit 0.
- **T-hook-static (R5):** static scan: no `child_process`, `spawn`, `exec`, no `writeFile`/`appendFile`/`mkdir`, no import outside the allowed builtins, no reads under `cwd` or of project `.claude/*` files; runtime check with a payload whose `cwd` is a temp dir containing a hostile `.claude/settings.json` made unreadable (mode 0000): exit 0, no error surfaced, and a read-spy wrapper run shows the file was never opened.
- **T-selfheal (R13):** the generated command (Task 7 exports `buildCommand(scriptPath)`; here test the sh guard against a temp path): missing script, unreadable script and `node` not on `PATH` each exit 0 within 100 ms with empty output; with everything present it `exec`s node (the process that holds the socket is the process the shell started).
- **T-timing (R3 bounds):** `slow-ack(450)` still exits normally; `slow-ack(700)` and `no-ack` exit by 500 ms (+ tolerance 150 ms); a listener that never accepts also exits by 500 ms. The idle-machine p95 budget (OQ24, under 400 ms for the whole hook including node startup) is measured by `scripts/bench-hook.mjs` (Step 4), not asserted in CI because CI load varies; CI asserts only the 500 ms bounds.
- **T-sigstop (R60):** stub server process SIGSTOPped after accept: hook exits 0 empty by 500 ms plus tolerance; the stopped process is resumed and killed in `afterEach` (never leave stopped processes).
- **T-hook-squatter (R21):** a squatter socket without the real secret returns a wrong MAC: the hook sends no payload (stub records bytes received after hello: zero).

- [ ] Step 1: scaffold the package, add it to the workspace, write the stub server and the first test (`hook-failopen`), see it fail (script absent).
- [ ] Step 2: implement `hook.js` minimally to pass; then add each remaining test one at a time, red then green.
- [ ] Step 3: run `node node_modules/vitest/vitest.mjs run` in `packages/hook`. Expected: all pass, total under 30 s.
- [ ] Step 4: `scripts/bench-hook.mjs`: 100 runs of the hook against the stub in `ack-none`, prints p50 and p95 in ms (numbers only). Run on a quiet machine and record in the S13 notes under `docs/v0.2/spikes/`; this closes S13's idle re-measure.
- [ ] Step 5: reviewers: `ecc:silent-failure-hunter` on `hook.js`, `ecc:security-reviewer`.
- [ ] Step 6: commit `feat(hook): fail-open hook script that cannot emit a verdict`.

### Task 3: state dir, instance lock, ingest listener, inspector guard (R16 server part, R18-R23 server side, R55, R60 server side, R67, R68, R70, R73, R78)

**Files:** Create `packages/server/src/{state-dir.ts,instance-lock.ts,ingest-socket.ts,inspector-guard.ts,script-hash.ts}`; Modify `packages/server/src/server.ts` (wire, behind an option `ingest?: { dir: string }` defaulting to off in unit tests); Tests `packages/server/test/{socket-hygiene.test.ts,instance-lock.test.ts,socket-takeover.test.ts,ingest-fuzz.test.ts,flood.test.ts,capabilities.test.ts,ingest-browser.test.ts,inspector.test.ts,script-hash.test.ts,peer-cred.test.ts}`.

Interfaces:
```ts
export type StateDir = { root: string; runDir: string; sockPath: string; secretPath: string }
export function ensureStateDir(home: string): StateDir            // R67: ~/.deskmates 0700; throws a coded error
export function openRunDir(dir: StateDir): void                    // R68: lstat + O_NOFOLLOW, owner uid check
export function acquireInstanceLock(dir: StateDir): { held: true; release(): void } | { held: false; otherPid: number } // R73: O_EXCL, pid+start time, probe-checked
export function writeIngestSecret(dir: StateDir): Buffer          // R20: temp then atomic rename, 0600, fresh each start
export type IngestHandlers = { onRequest(req: IngestRequest): { ack: 'held' | 'none'; requestId?: string } }
export function startIngest(opts: { dir: StateDir; secret: Buffer; now(): number; onRequest(...): ...; limits?: IngestLimits }): { close(): Promise<void>; counters(): IngestCounters }
export function inspectorActive(): boolean                         // R70: node:inspector url() or execArgv/NODE_OPTIONS inspector flags
export function hashScript(path: string): string                   // sha256 hex; R16
```
Behaviour: probe-connect a stale socket before unlinking and refuse to start ingest if a live listener answers (R68); the second instance starts passive and says so (R73); lstat the socket inode every 1 s and before each reply, on change or vanish drop pending requests and print an alarm to `/dev/tty` (R55, injectable `tty` writer for tests); `/v1/hello` MAC; `/v1/request` requires header secret (constant-time), `Content-Type: application/json`, body at most 1 MiB, JSON depth at most 16 and at most 200 keys, parser never throws out of the handler (always a 400 or `{ack:'none'}`), per-second rate limit and global pending cap 20 / per-session 5 (R22), drops `permission_suggestions` on arrival; in slice 1 every ack is `{ack:'none'}` (nothing is held, R3 note) and the connection is closed after the reply. Server startup computes the script hash and compares it with the shipped known-hash list (R76 server part); a mismatch only sets a `doctor`-visible flag in slice 1.

Tests:
- **T-socket-hygiene (R67, R68):** root created 0700; an existing 0755 root is refused or tightened per ADR (assert the chosen behaviour); `run/` symlink is refused; stale socket with no listener is unlinked; stale socket with a live listener makes ingest refuse to start; `ingest.json` exists at 0600 after start and a second start rewrites it atomically with a different secret; temp file never world-readable (run with `umask 0`).
- **T-instance-lock (R73):** second `acquireInstanceLock` while the first is live returns `held:false` and does not touch the socket; after the first process (a child) is killed with SIGKILL a new acquire succeeds and replaces a stale lock whose pid is dead or start time differs.
- **T-socket-takeover (R55):** replace the socket inode (unlink and rebind) mid-run: within 1.5 s the pending set is dropped, the alarm writer receives one line, ingest reports `disabled`.
- **T-ingest-fuzz (R22):** deeply nested JSON, 2 MiB body, duplicate keys, `__proto__`, lone surrogates, huge numbers, wrong content type, missing header, wrong secret: never an unhandled rejection or crash (spy on `unhandledRejection`), always 4xx or `ack:none`, counters increment by reason.
- **T-flood (R22, R72 server part):** 1000 requests in 1 s: rate limit engages, pending caps hold, memory bounded (assert map sizes), server still answers a good request afterwards.
- **T-capabilities (R19):** the ingest secret cannot open `/api/status` or the WS; the read token cannot call `/v1/request`; `/v1/hello` and `/v1/request` are the only routes on the socket.
- **T-ingest-browser (R18, socket half):** the socket has no TCP binding; no TCP fallback exists in slice 1 (assert the server's reported listen addresses contain only the browser listener).
- **T-inspector (R70):** `inspectorActive()` is true when `inspector.open()` was called in a child process and when started with `--inspect`; ingest refuses to start with it true and the reason code is in counters. `--disable-sigusr1` is added by the CLI launcher where `process.allowedNodeEnvironmentFlags` has it; SIGUSR1 policy per S16 (tested in a child process on the Node version running the suite; skip with a clear reason on versions without the flag).
- **T-script-hash (R16, R76 server part):** hash of a temp script matches `sha256sum`; unknown hash sets `scriptHashKnown:false`; the known list accepts the current and older shipped hashes.
- **T-peer-cred (R78, best effort):** assert the `doctor`-visible field `peerCred: 'unavailable'` on this Node (the gap is documented); no native dependency is added.

- [ ] Steps 1-5: per module, failing test, implement, pass. Commit after each module (`feat(server): state dir and instance lock`, `feat(server): ingest socket listener`, `feat(server): inspector guard and script hash`).
- [ ] Step 6: run the package suite and `tsc --noEmit`; reviewers `ecc:security-reviewer` and `ecc:silent-failure-hunter`; `agentic-council:Skeptic` re-review of ingest against `THREAT-MODEL.md` (briefed with the code, not the conclusion).

### Task 4: hook-based attention and the request store (R17, R22 pending, R23, R25, R44 slice 1 form, R62, R66, R72, R87 server half, E1-E3)

**Files:** Create `packages/server/src/{canonical-hash.ts,hook-attention.ts,request-store.ts}`; Modify `packages/server/src/{ticker.ts,server.ts}`; Tests `packages/server/test/{canonical-hash.test.ts,hook-attention.test.ts,hookseen.test.ts,corroboration.test.ts,transcript-path.test.ts,fairness.test.ts,secret-scan.test.ts}`.

Interfaces:
```ts
export function canonicalHash(toolName: string, input: unknown): string | undefined // R66: sorted by code point; undefined for unsafe ints, dup keys, lone surrogates, __proto__ (then "terminal only", no badge)
export type HookRequest = { requestId: string; sessionKey: string; toolName: string; toolInput: unknown; cwd: string; permissionMode?: string; receivedAt: number }
export function createRequestStore(opts: { now(): number; maxPerSession: 5; maxGlobal: 20; ttlMs: 120_000 }): {
  add(r: HookRequest): { evicted?: string }      // R72: evict oldest "not seen in transcript" first, never a seen one
  get(id: string): HookRequest | undefined
  drop(id: string, why: 'tool-end' | 'expired' | 'session-end' | 'superseded'): void
  list(): readonly HookRequest[]                 // memory only
}
export function createHookAttention(opts: { bus: EventBus; store: RequestStore; now(): number; waitMs: 10_000; staleMs: number }): { onIngest(...): void; sessionHookState(key): 'seen' | 'stale' | 'none' }
```
Behaviour (SPEC section 7 E1 rules, option A): match a hook request to an open tool of that agent by tool name plus canonical hash (hash kept in memory beside `openTools` ids, never in events); on match publish `attention{toolUseId: real id, source:'hook', requestId}`; no match yet: wait up to 10 s for a matching `tool.start`, else no attention and the request lives only in the store; several pending for one agent: the reducer slot keeps the oldest, the server publishes attention for the next when the slot settles; publish `session.hook seen` on the first ingest and `stale` after `staleMs` without one (R17: from real ingests only, never from settings); `ticker.ts` skips heuristic attention for sessions whose hook state is fresh (E1 rule 3); drop store entries on the matching `tool.end`, `agent.end` or 120 s (R87); the corroboration badge (R25) is computed only from transcripts the watcher already discovered, and `transcript_path` from the payload is compared to known paths and never opened (R62).

Tests:
- **T-corroboration (R25) and T-forger:** a request matching an open transcript `tool_use` by session, tool and hash gets `transcriptSeen:true`; a forged request with no matching tool gets `false`; the flag never affects any other behaviour.
- **T-transcript-path (R62):** a payload whose `transcript_path` is `/etc/passwd` or a symlink is never opened (spy on `fs` calls from the module), only compared.
- **T-hookseen (R17):** no ingest means no `seen` even when the settings entry exists; `seen` after one ingest; `stale` after `staleMs` (fake clock); the badge carries `permissionMode`.
- **hook-attention E1 tests:** match, late match inside 10 s, no match after 10 s (no `attention` event), two pending for one agent (oldest in slot, next published after settle), `tool.end` clears the store entry and the attention via the existing reducer (no reducer change), ticker suppression while fresh and heuristic resumes when stale.
- **T-fairness (R72):** at the per-session cap the oldest not-seen request is evicted, a seen one never; the global rate limit is shared with Task 3.
- **canonical-hash vectors (R66):** nested objects sorted by code point not UTF-16 unit, unicode, empty objects, arrays kept in order, unsafe integer returns undefined, duplicate keys detected from the raw text, `__proto__` rejected.
- **T-secret-scan (R20, R23, R26 part, R44 part):** drive a request with a canary string in `tool_input` and a canary ingest secret through the whole server (bus events, snapshot, `/api/status`, logs captured via the injected logger, audit file, the temp state dir contents, backups): the canary appears in none of them; no file named or containing `grant`, `pairing`, or a decide capability exists in the state dir (R26). The only place the input canary may appear is the R87 `request` frame (Task 5 test).

- [ ] Steps 1-5 per module; commits `feat(server): canonical hash and request store`, `feat(server): hook attention with E1 correlation`, `feat(server): suppress heuristic attention while hooks are live`.
- [ ] Step 6: run server suite, `tsc`, `node scripts/attack.mjs`. Reviewers as Task 3.

### Task 5: WebSocket `verified` flag and read-only pushes (R44 slice 1 form, R87, protocol E4)

**Files:** Modify `packages/server/src/ws.ts`, `packages/server/src/security.ts` (add `isVerifiedOrigin`), `packages/client/src/net/protocol.ts` (parse only, rendering is Task 10); Tests `packages/server/test/{ws-verified.test.ts,raw-scope.test.ts,protocol-schema.test.ts}`, `packages/client/test/protocol.test.ts` (extend).

Interfaces:
```ts
// security.ts
export function isVerifiedOrigin(headers: IncomingHttpHeaders, port: number): boolean // Origin present and exactly http://127.0.0.1:PORT or http://localhost:PORT, AND (Sec-Fetch-Site absent OR === 'same-origin'). S9: Chromium sends no Sec-Fetch-* on WebSocket upgrades, WebKit does; absent must verify, a present non-same-origin value must not
// server -> client, additive; protocol v stays 1, v0.1 clients ignore unknown types
type RequestMsg = { type: 'request'; requestId: string; sessionKey: string; toolName: string; toolInput: unknown; cwd: string; permissionMode?: string; transcriptSeen: boolean; receivedAt: number; expiresAt: number }
type RequestStateMsg = { type: 'request.state'; requestId: string; state: 'shown' | 'ended' | 'expired'; reason?: string }
type ControlStateMsg = { type: 'control.state'; hookSeen: Record<string, 'seen' | 'stale'>; permissionModes: Record<string, string>; foreignHook?: string[] /* file names only */ }
```
Behaviour: `request` frames go only to connections that passed the token check AND are `verified`; they are pushed live, never included in `snapshot` or `resync` replies, never in `events` frames; on connect a verified connection receives the currently held requests once (memory-only, 120 s window); `request.state ended` is pushed when the tool ends; the client-to-server surface stays `resync` only (maxPayload 4096, 5/s limit unchanged); every `request` frame goes through `redactWith` like all other frames (home to `~`, secret masks) so the live channel cannot leak secrets.

Tests:
- **T-raw-scope (R87, R44):** an unverified connection (no Origin, a wrong Origin, or Origin exact but `Sec-Fetch-Site: same-site` or `cross-site`); a connection with exact Origin and no `Sec-Fetch-Site` (the Chromium case) IS verified with the right token receives snapshots and events but never a `request` frame; a verified one does; `snapshot` and `resync` replies contain no `toolInput` anywhere (deep scan); the raw string appears in no `events` frame; after the tool ends or after 120 s (fake clock) the store has dropped the entry and a reconnecting verified client does not receive it.
- **T-protocol-schema (R34):** enumerate every message type the server can send and accept: assert no `decide`, `grant`, `focus`, `session.optin` type exists on either side and the hook output set (Task 2 constants) is `{nothing}` only.
- **ws-verified:** table test over Origin (missing, exact on 127.0.0.1 and localhost, wrong port, `null`, attacker host) and Sec-Fetch-Site (absent, `same-origin`, `same-site`, `cross-site`, `none`) against `isVerifiedOrigin`; absent plus exact Origin is verified, every other row follows the rule above. Driven by `spikes/S9.md`.

- [ ] Steps 1-5, commit `feat(server): verified connections and read-only request pushes`.

### Task 6: `/api/exchange`, stricter checks, launch URL on the tty, status counters (R47, R53, R56 slice 1)

**Files:** Create `packages/server/src/exchange.ts`, `apps/cli/src/tty.ts`; Modify `packages/server/src/{security.ts,http.ts,server.ts}`, `apps/cli/src/{args.ts,main.ts,bin.ts}`, `packages/client/src/net/{token.ts,exchange.ts}`, `packages/client/src/app.ts` (boot only); Tests `packages/server/test/{nonce.test.ts,status.test.ts,security.test.ts (extend),http.test.ts (extend)}`, `apps/cli/test/tty-only.test.ts`, `packages/client/test/exchange.test.ts`, `scripts/attack.mjs` (extend).

Interfaces:
```ts
export function createExchange(opts: { token: string; now(): number; random(bytes: number): Buffer; onReuse(): void }): {
  issue(): string                        // 128-bit base64url nonce, valid 30 s, single use
  redeem(nonce: unknown): string | undefined  // consumed on first lookup even if malformed; returns the read token
}
// security.ts
export function checkExchangeRequest(req: IncomingMessage, port: number): { ok: true } | { ok: false; reason: 'host'|'origin'|'fetch-site'|'content-type'|'method' }
// X rules (SPEC 6.1): exact single Host, Origin PRESENT and exact, Sec-Fetch-Site same-origin, Content-Type application/json, body <= 256 bytes
```
Behaviour: `POST /api/exchange` with body `{"nonce":"…"}` returns `{"token":"…"}` with `Cache-Control: no-store`; every refusal returns a generic body and increments a counter by reason (`bad-host`, `bad-origin`, `fetch-site`, `nonce-reuse`, `nonce-expired`, `bad-body`); reuse prints one loud line to the tty (injectable writer); all other routes keep the v0.1 checks (v0.1 behaviour stays for read-only routes, exactly as SPEC 6.1 says); `/api/status` gains `hookSeen`, `ingest` counters and the refusal counters, no content. The CLI prints the launch URL (`http://127.0.0.1:PORT/#n=<nonce>`) only to `/dev/tty` (R56): not stdout, not stderr, not logs; with no tty it prints a clear refusal naming `--no-open` and an explicit new flag `--print-url` that prints to stdout (owner-visible tradeoff documented in the CLI README). The client reads `#n=`, strips the fragment, POSTs `/api/exchange`, then connects the WebSocket with the returned token as today; `#t=` (v0.1 links) keeps working until Task 13 decides removal (OQ4).

Tests:
- **T-nonce (R47):** valid exchange succeeds once; second use is refused and prints the loud line; expiry at 30.001 s refused (fake clock); a malformed body still consumes a valid nonce; missing Origin refused (stricter than v0.1); `Origin: null` refused; wrong-port Origin refused; `Sec-Fetch-Site: same-site` or `none` refused; `Content-Type: text/plain` refused; oversized body refused; GET refused with 405; the token is in no response header and the nonce is in no server log; the CLI test inspects the spawned opener's args (only the nonce URL when the opener is used; the nonce is useless after one use; document that the opener still sees the nonce).
- **T-status (R53):** each refusal reason increments exactly its own counter and `/api/status` shows them; no counter name or value contains request content.
- **T-tty-only (R56 slice 1):** run the CLI against a fake tty: the launch URL appears on the tty writer and on neither stdout nor stderr (capture both); without a tty and without `--print-url` the URL is printed nowhere and the exit message says how to proceed.
- Extend `scripts/attack.mjs` with exchange attacks (reuse, rebinding Host, cross Origin, no Origin, big body, slowloris on the route): all refused; run `node scripts/attack.mjs`. Expected: all attacks refused (count rises from 237).

- [ ] Steps 1-5, commits `feat(server): nonce exchange and stricter checks for state-changing routes`, `feat(cli): launch URL to the tty only`.
- [ ] Step 6: `ecc:security-reviewer` on `exchange.ts`, `security.ts`, `tty.ts`; `agentic-council:Skeptic` on the OQ4 decision's residual risk.

### Task 7: install/uninstall engine and the fixture corpus (R8 engine part, R9-R12, R14, R16, R64, R76)

**Files:** Create `packages/install/{package.json,tsconfig.json}` and `src/{patch.ts,scope.ts,backup.ts,atomic.ts,install.ts,uninstall.ts,manifest.ts,command.ts,index.ts}`, `test/{install-fixtures.test.ts,install-backup.test.ts,install-race.test.ts,install-scope.test.ts,uninstall-bytes.test.ts,upgrade.test.ts}`, `test/fixtures/` (JSON files: empty `{}`, no `hooks`, foreign `PermissionRequest` hook, comments and trailing commas (JSONC), CRLF, tabs, 4-space indent, BOM, duplicate keys, symlinked target, unparseable, unusual key order, unicode, existing deskmates entry v1, existing entry with edited command).

Interfaces:
```ts
export type Scope = 'project-local' | 'project-shared' | 'user-global'   // project-local = .claude/settings.local.json; shared = git-tracked settings.json (needs extra flag, R14); managed is never written
export type Plan = { path: string; realPath: string; before: string; after: string; diff: string; scope: Scope; warnings: string[] }
export function planInstall(opts: { scope: Scope; projectDir?: string; home: string; scriptPath: string; allowTracked?: boolean; confirmAllProjects?: boolean }): Plan  // pure, writes nothing (--dry-run)
export function applyInstall(plan: Plan, io: { fsync: boolean; now(): number }): { backupPath: string; manifest: InstallManifest }
export function planUninstall(opts: { manifestPath: string }): Plan
export function applyUninstall(plan: Plan): { restored: 'byte-identical' | 'edited-kept' }
export type InstallManifest = { v: 1; marker: 'deskmates:v1'; settingsPath: string; command: string; scriptSha256: string; backupPath: string; installedAt: number }
export function buildCommand(scriptPath: string): string  // the self-healing sh guard with the trailing marker comment; exact form fixed by S5
```
Behaviour: minimal text patch (insert the one hook entry into `hooks.PermissionRequest`, create the nesting if absent) so unrelated bytes are untouched (comments, formatting, newline style, key order); refuse an unparseable file and a duplicate key at any level touched (R64); the settings entry has `matcher: "*"`, `timeout: 30` (SPEC R3), never `onFailure`; backup written first, mode 0600 in a 0700 dir, last 10 kept (R9, R64); write is temp, fsync, rename, preserving mode and symlinks (write to the real target, R64), and aborts with no change if sha256, mtime or size changed since read (R11); uninstall removes only entries carrying the marker AND the exact recorded command (R12): an unchanged file gives bytes identical to the backup, a changed file shows a diff and asks, keeping user edits; upgrade (R76): re-install shows a diff of the script only (settings entry unchanged), replaces the script atomically (copy to dir 0700, file 0500), updates the manifest; script hash recorded (R16). The engine takes injected `io` so tests need no tty; the interactive consent (R8) lives in Task 8.

Tests (all against fixture copies in temp dirs; never real settings):
- **T-install-fixtures (R10, R64):** for every fixture: install, then compare the diff to a golden file; only the expected lines changed; foreign hooks preserved byte for byte; comments, CRLF, tabs, BOM kept; unparseable and duplicate-key fixtures refused with no write; the symlink fixture writes to the target and leaves the symlink intact.
- **T-install-backup (R9):** the backup exists before the settings write (inject a failure at write time: backup still there, settings unchanged), mode 0600, directory 0700, eleven installs keep the newest ten.
- **T-install-race (R11):** mutate the file between read and write (hook in `io`): apply aborts, file untouched, no temp file left behind; a mid-write failure leaves the original intact (atomic).
- **T-install-scope (R14):** no default scope: omitting `scope` is a type error and a runtime refusal; `user-global` requires `confirmAllProjects: true`; a git-tracked project file requires `allowTracked`; a path under a managed-settings directory is refused; tracked-ness is determined through the realpath of a symlink.
- **T-uninstall-bytes (R12):** on the full corpus, install then uninstall gives a byte-identical file when unchanged; with a user edit in between the user's edit survives and only the deskmates entry is removed, after a shown diff; an entry with the marker but a different command is left alone and reported; uninstall offers to delete backups (returns the list, deletes nothing itself).
- **T-upgrade (R76):** a new script hash changes only the script and the manifest; settings bytes identical; the consent diff shows the script change; the known-hash list in `packages/server` accepts the old hash.

- [ ] Steps 1-5 per module; commits `feat(install): settings patch engine`, `feat(install): backup and atomic write`, `feat(install): uninstall and upgrade`.
- [ ] Step 6: `ecc:security-reviewer` plus `ecc:silent-failure-hunter`; `agentic-council:Skeptic` re-review of install against THREAT-MODEL I1-I13.

### Task 8: CLI `hooks install|uninstall`, `doctor`, consent (R8, R14 UX, R15, R63 doctor part, R70 doctor, R75 doctor, R78 doctor)

**Files:** Create `apps/cli/src/{hooks-cmd.ts,doctor-cmd.ts}`, `packages/install/src/{doctor.ts,tested-versions.ts}`; Modify `apps/cli/src/{args.ts,main.ts,bin.ts}`; Tests `apps/cli/test/{install-consent.test.ts,doctor.test.ts,args.test.ts (extend)}`, `packages/install/test/doctor.test.ts`.

Commands: `deskmates hooks install [--dry-run] [--scope <s>] [--allow-tracked]`, `deskmates hooks uninstall`, `deskmates doctor`. No `--yes` flag exists (R8). Install needs an interactive TTY on stdin and stdout, shows the unified diff and absolute path, asks the scope (suggests project-local), states the blast radius for user-global and requires a typed confirmation for it, and lists every other `PermissionRequest` hook and `disableAllHooks` it finds in any layer (R15); it never says deskmates "gates" an action; it says plainly that v0.2 cannot approve or deny (R45 text). `--dry-run` prints the same plan and writes nothing. `doctor` is read-only: script present, mode and hash against the manifest and the known list; settings entry present and unmodified; foreign `PermissionRequest` hooks in user, project and local layers plus `disableAllHooks`; the cwd's project settings scanned as data (R63: realpath inside cwd, size cap, only the two file names); `claude --version` via `execFile` with a fixed argv (R75) against the tested list; inspector flags (R70); peer-cred availability (R78); ingest socket dir and mode. No postinstall script anywhere (R8): a test asserts no `postinstall`, `preinstall` or `install` script in any shipped `package.json`.

Tests:
- **T-install-consent (R8):** non-tty stdin: refused with exit code 2 and no write; `--yes` is an unknown flag; `--dry-run` leaves the temp project byte-identical; declining at the prompt writes nothing; the diff and path appear before the prompt; the tracked-file and user-global paths need their extra confirmation text; no lifecycle scripts in any shipped `package.json`.
- **T-doctor (R15, R63, R70, R75, R78):** fixture projects with foreign hooks in each layer are all listed; `disableAllHooks:true` is reported; a version outside the tested list is reported as "control not supported"; doctor never writes (directory snapshot before and after is identical).

- [ ] Steps 1-5, commit `feat(cli): hooks install, uninstall and doctor with consent`.
- [ ] Step 6: owner checkpoint: show the dry-run output against a throwaway project. **Do not run a real install** (needs the owner's separate explicit yes, SPEC section 13 sign-off).

### Task 9: audit skeleton (R52)

**Files:** Create `packages/server/src/audit.ts`; Modify `packages/server/src/{server.ts,hook-attention.ts}` (emit only); Test `packages/server/test/audit.test.ts`.

Interface: `createAudit(opts: { dir: StateDir; now(): number }): { record(e: AuditEntry): void }` with `AuditEntry = { t: number; requestId: string; session: string /* short id */; tool: string; outcome: 'observed' | 'dropped' | 'evicted'; connection?: string; latencyMs?: number }`. File `~/.deskmates/audit.jsonl`, mode 0600, append only, 5 MB x 3 rotation, allowlisted fields only.

- **T-audit:** file mode 0600; an entry with extra fields (including `toolInput`, `command`, hashes, secrets) is stripped to the allowlist (property test with random extra keys); rotation at 5 MB keeps 3 files; a write failure never throws into the request path (counter increments); no hash or hash prefix of input ever appears (canary).
- [ ] Steps 1-5, commit `feat(server): audit skeleton`.

### Task 10: the read-only Needs-you card, badges, banner (R25, R37, R38, R42, R43, R45, R46, R57, R59, R77, R86 slice 1)

**Files:** Create `packages/client/src/hud/{needs-you-card.ts,escape.ts}`, `scripts/lint-sinks.mjs`; Modify `packages/client/src/net/{protocol.ts,mirror.ts,connection.ts}`, `packages/client/src/app.ts`, `packages/client/src/hud/*` (card slot, badge, banner); Tests `packages/client/test/{render-corpus.test.ts,render-length.test.ts,render-cwd.test.ts,badge.test.ts,ghost.test.ts,multisession.test.ts,xss.test.ts}`, `packages/client/test/fixtures/hostile-corpus.json`.

Interfaces:
```ts
// escape.ts: R59
export function escapeText(s: string): { runs: Array<{ text: string; escaped: boolean; codepoint?: string }>; nonAscii: string[] /* U+XXXX list */ }
// needs-you-card.ts
export type CardModel = { requestId: string; sessionLabel: string; cwd: string; branch?: string; agent: string; tool: string; fields: Array<{ key: string; lines: Array<{ n: number; runs: Run[] }>; totalChars: number; totalLines: number; expanded: boolean; tooBig: boolean }>; badges: string[]; banner?: string }
export function buildCardModel(msg: RequestMsg, ctx: SessionCtx): CardModel   // pure, tested without a DOM
export function mountCard(root: HTMLElement, model: CardModel): { update(m: CardModel): void; destroy(): void }  // textContent only
```
Behaviour: every key of `toolInput` is shown, read-only, with line numbers; text outside printable ASCII is shown as visible escapes (`\u{202E}`) unless inside an allowlisted script run the user sees labelled (R59), including NBSP, U+3000, U+2028/2029, U+2800, U+3164, all Zs/Zl/Zp/Cf, combining marks, variation selectors, tag characters and ANSI ESC sequences; a non-ASCII badge lists codepoints; fields over 2000 characters or 40 lines show head and tail with length and line count and an expand control; any single field over 16 KiB or the whole input over 32 KiB shows head and tail only with "answer in the terminal" (nothing silently truncated: the count of hidden characters is shown); `description` is labelled model-written and untrusted; `cwd` is labelled "session directory" with the note that the command may run elsewhere because Bash keeps `cd` between calls (R77); the card says "reported by hook", shows the "seen in transcript" or "not seen in transcript" badge (informational, R25) and the permission-mode badge, and the page states "deskmates cannot approve or deny in this version; answer in the terminal" (R45); same-cwd sessions are disambiguated by short id and entries are never merged or reordered under the cursor (R43); the card drops on `request.state ended`, session end or 120 s (R46, no "applied" wording); a banner names a foreign `PermissionRequest` hook file from `control.state.foreignHook` (R63 card part); the card has no controls that send anything. OS notifications (R42) do not ship in v0.2 (off by default, OQ15): a test asserts no `Notification` API use in client source. Accessibility: the card is a labelled region (`role="region"`), has headings, keyboard-reachable expand controls, visible focus and no colour-only state (re-checked by the `Accessibility Auditor`).

Tests:
- **T-render-corpus (R37, R59):** every item of `hostile-corpus.json` (RTL override, zero-width joiner, tag characters, variation selectors, NBSP, ideographic space, line and paragraph separators, braille blank, Hangul filler, combining stacks, ANSI colour and cursor sequences, homoglyph path, lone surrogates, a 10k-combining-mark string, `<img onerror>` and `<script>` strings) renders with every non-printable-ASCII code point escaped or labelled; the DOM has no element created from payload text (no `img`, `script`, `a` inside the card) and the card's `innerHTML` holds no unescaped angle bracket from the payload.
- **T-render-length (R38, R86):** the 2000-char and 40-line boundaries (just under, exactly at, just over); a 16 KiB field and 32 KiB total: "answer in the terminal" shown, hidden count correct, head and tail both present.
- **T-render-cwd (R77):** label text present and `cwd` rendered through `escapeText`.
- **T-badge (R45):** hook seen, not seen, stale, each permission mode string (including an unknown and a hostile one); the "cannot approve or deny" text is always on the page.
- **T-ghost (R46):** card removed on `request.state ended`, on session end and after 120 s (fake clock); no stale card after reconnect.
- **T-multisession (R43):** two sessions with the same cwd show different short ids; a third request arriving does not move the displayed card.
- **T-xss (R40):** `buildCardModel` and `mountCard` fuzzed with the corpus (model-level assertions plus a DOM check only if a DOM test library is already a dev dependency; no new dependency), and `scripts/lint-sinks.mjs` (run by `pnpm -r test`) fails the build if client source contains `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `setAttribute('on…')` or `srcdoc` (the lint is itself tested with a seeded violation).
- [ ] Steps 1-5; commits `feat(client): escaping and card model`, `feat(client): needs-you card and badges`, `feat(client): sink lint`.
- [ ] Step 6: browser check on the live app (rebuild client and CLI, restart, reload the pane): real data only, never read or screenshot the owner's session content; verify the card with a synthetic stub request through the stub-hook harness against a **separate** server on another port with fixture transcripts. Reviewers: `Accessibility Auditor` (card), `ecc:code-reviewer`, `ecc:security-reviewer`.

### Task 11: CSP, headers and framing (R40 CSP half)

**Files:** Modify `packages/server/src/security.ts` (`SECURITY_HEADERS`), client build for Trusted Types; Tests `packages/server/test/{csp.test.ts,iframe.test.ts}`.

Behaviour: every page response carries the strict CSP already in place plus `require-trusted-types-for 'script'` (the client creates no policy because it has no sinks, so any sink use throws), `frame-ancestors 'none'` and `X-Frame-Options: DENY`, on `/`, assets and error pages.
- **T-csp:** exact header strings on `/`, a static asset, a 404 and a 405; no `unsafe-inline`, `unsafe-eval`, wildcard or `data:` script source; the built `index.html` has no inline script or style (parse it).
- **T-iframe:** header assertions here; the real framing attempt runs in Task 12.
- [ ] Steps 1-5, commit `feat(server): trusted types and anti-framing headers`.

### Task 12: real-browser rebinding harness Tier 1 (R54, R65; Playwright is the one new dependency)

**Ask first.** Before Step 1, ask the owner to confirm adding Playwright (OQ17 recorded "dev-only, contained"; the pin and CI details need a fresh yes because it changes `pnpm-lock.yaml` and CI).

**Files:** Create `packages/rebind-harness/{package.json,tsconfig.json,src/rebind-server.ts,test/rebind.spec.ts,test/rebind-mutation.spec.ts}`, `.github/workflows/rebind.yml`, `scripts/tarball-check.mjs`; Modify `pnpm-workspace.yaml` only if needed, `.npmrc` (CI `--ignore-scripts` and an allowlist), root `package.json` scripts; Tests T-rebind, T-tarball, T-iframe (browser half).

Behaviour (SPEC section 12.1): Playwright pinned exactly (no caret), `private: true`, not in any `files` list; browser binaries installed by an explicit CI step; CI installs with `pnpm install --frozen-lockfile --ignore-scripts` plus an explicit allowlisted rebuild step; the job holds no secrets and uses the default read-only token. The harness starts a real deskmates server on a loopback port with fixture data, serves an attacker page from a second origin (`attacker.test` mapped to 127.0.0.1 via a host-resolver rule), and tries from that page: `fetch` and `XMLHttpRequest` to `/api/status` and `/api/exchange`, a WebSocket upgrade with and without Origin, DNS rebinding (the hostname flips from the attacker IP to 127.0.0.1 between requests), and framing the page in an `<iframe>`; all must be refused or inert, in Chromium and Firefox.
- **T-rebind:** each attack above fails; **positive control:** the same harness against a deliberately weakened server (Host check disabled via a flag compiled only into the harness) succeeds, proving the harness can detect a hole; **mutation check:** a CI step runs the harness against builds with one check removed (Host, Origin, Sec-Fetch-Site, nonce single-use in turn) and expects the harness to fail each time.
- **T-tarball (R65):** `npm pack --dry-run --json` for the published package lists no `rebind-harness`, no Playwright, no `.spec.ts`; the lockfile diff adds Playwright only under the harness package.
- **T-iframe (browser half):** the page cannot be framed from `attacker.test` (blocked by `frame-ancestors` and `X-Frame-Options`).
- [ ] Steps 1-5; commits `ci: real-browser rebinding harness`, `ci: tarball contents check`.
- [ ] Step 6: run the harness locally for Chromium and Firefox (needs browser binaries: ask before downloading, state size and source). Report pass counts, mutation results and timing. WebKit is not in the gate (S9 may add it).

### Task 13: docs, release prep and the slice 1 gate (Slice 4 of SPEC)

**Files:** Modify `docs/SECURITY.md` (OQ4c amendment), `README.md`, `apps/cli/README.md`, `docs/ROADMAP.md`, `docs/v0.2/SPEC.md` (status rows), `scripts/attack.mjs`; Test `packages/server/test/secret-scan-final.test.ts`.

- [ ] Step 1: SECURITY.md amendment: the per-run-secret plus Host and Origin rule applies to browser-reachable endpoints and is unchanged; the Unix-socket ingest authenticates by location, mode, secret and MAC; `/api/exchange` is the owner-approved exception (token not required, nonce plus strict headers instead); the same-uid ceiling; no sandbox claim; v0.2 cannot approve or deny.
- [ ] Step 2: README and CLI README: how to run, the `hooks install` consent flow, what the hook can and cannot do (cannot emit allow or deny), launch URL and tty behaviour, `--print-url`, fail-open, uninstall.
- [ ] Step 3: run the whole gate: every package `vitest` and `tsc`; `node scripts/attack.mjs` under Node including `/api/exchange`; `pnpm install --frozen-lockfile`; `node scripts/slice1-coverage.mjs` (all R-ids and all T-names found in tests, none missing); byte-identical uninstall on the corpus; `kill -9` of the server and of the hook mid-run; the fail-open matrix; `node scripts/bench.mjs` (50-session benchmark unchanged within noise); hook p95 from `scripts/bench-hook.mjs` on an idle machine.
- [ ] Step 4: reviewers in parallel (briefed with the diff and the SPEC rows, not with this plan's conclusions): `ecc:security-reviewer`, `ecc:silent-failure-hunter`, `ecc:code-reviewer`, `agentic-council:Skeptic` (ingest and install against the threat model), `Accessibility Auditor` (card), plus `claude-code-guide` for the settings and hook doc cross-check. Fix findings test-first.
- [ ] Step 5: `verification-before-completion`: paste real command output for each gate item into the PR description. Waive nothing; R69 and R2 are unwaivable.
- [ ] Step 6: **Owner sign-off before the first real install on the owner's machine, and a separate explicit yes before any npm publish.** Neither is done by the agent on its own.
- [ ] Step 7: commit `docs: v0.2 security amendment, README and gate results`.

---

## Self-review

**Spec coverage** (every [S1] id and the slice 1 part of [S1+P] ids from SPEC section 13; `scripts/slice1-coverage.mjs` checks this table mechanically):

| Requirement | Task | Requirement | Task |
|---|---|---|---|
| R1 | 2, 5 (T-protocol-schema) | R47 | 6 |
| R2 | 2 | R52 | 9 |
| R3 | 2, 7 (timeout value) | R53 | 6 |
| R5 | 2 | R54 | 12 |
| R7 | 2 | R55 | 3 |
| R8 | 8 | R56 | 6 |
| R9 | 7 | R57 | 10 |
| R10 | 7 | R59 | 10 |
| R11 | 7 | R60 | 2, 3 |
| R12 | 7 | R62 | 4 |
| R13 | 2 | R63 | 8, 10 |
| R14 | 7, 8 | R64 | 7 |
| R15 | 8 | R65 | 12 |
| R16 | 3, 7, 8 | R66 | 4 |
| R17 | 4 | R67 | 3 |
| R18 | 3, 12 | R68 | 3 |
| R19 | 3 | R69 | 2 |
| R20 | 3, 4 | R70 | 3, 8 |
| R21 | 2, 3 | R72 | 4 |
| R22 | 3, 4 | R73 | 3 |
| R23 | 4 | R75 | 8 |
| R25 | 4, 10 | R76 | 3, 7 |
| R26 | 4 | R77 | 10 |
| R34 | 5 | R78 | 3, 8 |
| R37 | 10 | R86 | 10 |
| R38 | 10 | R87 | 4, 5 |
| R40 | 10, 11, 12 | R42 | 10 (no notifications ship; asserted) |
| R43 | 10 | R44 | 4, 5 |
| R45 | 8, 10 | R46 | 10 |

**Test names:** T-hook-failopen, T-script-noverdict, T-hook-static, T-selfheal, T-timing, T-sigstop, T-hook-squatter (2); T-socket-hygiene, T-instance-lock, T-socket-takeover, T-ingest-fuzz, T-flood, T-capabilities, T-ingest-browser, T-inspector, T-script-hash (3); T-hookseen, T-corroboration, T-forger, T-transcript-path, T-fairness, T-secret-scan (4); T-raw-scope, T-protocol-schema (5); T-nonce, T-status, T-tty-only (6); T-install-fixtures, T-install-backup, T-install-race, T-install-scope, T-uninstall-bytes, T-upgrade (7); T-install-consent, T-doctor (8); T-audit (9); T-render-corpus, T-render-length, T-render-cwd, T-badge, T-ghost, T-multisession, T-xss (10); T-csp, T-iframe (11); T-rebind, T-tarball (12). T-peer-cred is best effort (3). The gate list in SPEC section 13 names 38 tests; all appear above.

**Placeholder scan:** no TBD or "handle edge cases". Three deliberate pointers to results that do not exist yet rather than invented values: the exact marker comment and sh guard form (S5; Task 7 `buildCommand`, tested by T-selfheal), the idle-machine p95 (OQ24; recorded from `bench-hook.mjs`), and the tested Claude Code version list (data the owner confirms in Task 8 from `claude --version` on their machine).

**Type consistency:** `HOOK_MARKER`/`deskmates:v1` (Task 2 constants, Task 7 manifest), `StateDir` (Task 3, used by 4 and 9), `HookRequest` and `RequestStore` (Task 4, used by 5), `RequestMsg`/`RequestStateMsg`/`ControlStateMsg` (Task 5, parsed there, rendered by 10), `InstallManifest` (Task 7, read by 8), `AttentionOutcome` and `session.hook` (Task 1, published by 4). `isVerifiedOrigin` (Task 5) and `checkExchangeRequest` (Task 6) are separate functions on purpose: the first gates a read-only push, the second a state-changing route.

**Known gaps and risks to watch:** S5 (rest), S6 and S8 results can change Task 7 (settings forms, live reload, `disableAllHooks`, untrusted project hooks) and Tasks 5 and 10 (S8: mode and agent badges); run them first. S9 is done and already folded into Task 5 (Chromium sends no `Sec-Fetch-Site` on WebSocket upgrades); Task 12 must measure Firefox, which S9 could not launch, and confirm `fetch` to `/api/exchange` carries `Sec-Fetch-Site` in every browser. S14's margin on R60 is thin; consider a 350 ms ack deadline if Task 2 measurements are tight. Slice 2 items (decide, grant, pairing, verdict code) are deliberately absent: a reviewer should treat any of them appearing in a diff as a defect.
