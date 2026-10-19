# deskmates v0.2 threat model: control

Status: draft, Skeptic lens (red). Design level. v0.1 server source was read only to understand its surface; nothing was reviewed or run. Extends `docs/SECURITY.md`; where they differ, the stricter rule wins.

v0.2 adds the first state-changing path: a browser click can make Claude Code run a tool. The worst case is arbitrary command execution as the user, through the user's own agent. Every design choice below is judged against that.

Severity: Critical = remote or cross-origin action, or silent approval. High = approval of something the user did not see, or session wedged. Medium = confusion, partial leak, local-only abuse. Low = nuisance. Likelihood: L / M / H.

### Two adversaries

The controls differ for the two adversaries, and neither set stops the other.

- A. Malicious web page. Stopped by exact `Host`, a present exact same-origin `Origin`, `Sec-Fetch-Site: same-origin` on every state-changing request (v0.1's "missing Origin allowed" and "refuse only cross-site" are too weak for decide), `frame-ancestors`, CSP, a user gesture and dwell. Not stopped: script running inside our own origin (D5, R-B).
- B. Prompt-injected model, or any other process of the same user. It can run `curl`, read any file, env var and `ps` argv, and forge `Origin` and `Sec-Fetch-*`, so header checks do nothing against it. The decide capability must therefore not exist on disk, in env, in argv or in the launch URL; it is delivered out of band to the human (a pairing code printed on the terminal where deskmates runs, exchanged over loopback for a grant held in page memory). Residual: an agent that can read that terminal or drive the user's browser defeats it. The hook (ingest) secret is readable by B by necessity, so it is not a protected capability: it authenticates the hook peer, and whoever holds it can answer the hook, take over the socket and self-approve (the same-uid ceiling, H8, R-A). It must differ from the browser grant and the read token. Requests forged through our server only social-engineer the user (labelled "reported by hook", transcript badge; `SPEC.md` section 4.4). The same-uid ceiling: a same-uid process can already edit Claude Code settings or run `claude`, so deskmates adds no capability against it; it must only not lower the bar for the normal flow and not widen the blast radius (a user-global install reaches every project).

## 0. ASSUMPTIONS TO VERIFY

Status as of 2026-10-19, from the official docs (hooks, permissions, settings, sub-agents, headless under `code.claude.com/docs/en/`). VERIFIED = stated in the docs. REFUTED = docs say otherwise. SPIKE Sn = not stated; settled by spike Sn in `docs/v0.2/SPEC.md` section 15, with its pass criterion there.

| ID | Assumption about Claude Code hooks | Status | If false |
|---|---|---|---|
| A1 | A `PermissionRequest` hook event exists and fires only when Claude Code would otherwise show a permission dialog (not for already-allowed or already-denied calls). | VERIFIED (`hooks`, `permissions`): runs only when about to ask or auto-deny; rule-decided calls skip it | Needs-you and approve cannot be hook-based; fall back to heuristic plus jump only. |
| A2 | The hook gets a JSON object on stdin with at least `session_id`, `cwd`, `tool_name`, `tool_input` (verbatim, full size), and a transcript path. | VERIFIED for the fields (also `permission_mode`, `hook_event_name`, optional `mcp_server`, `permission_suggestions`; no `tool_use_id`). "Verbatim, full size": SPIKE S7 | Display and binding (X2, D1) need another source. |
| A3 | Output: empty stdout with exit 0 means "no decision" and the normal terminal dialog still appears. A JSON object can return allow or deny. | VERIFIED (exit 0 plus no output leaves the normal flow; JSON allow or deny applies). That the dialog really appears after a crash: SPIKE S2 | Fail-open design (section 3.5) collapses; may need to ship report-only. |
| A4 | A hook that crashes, exits non-zero (other than the blocking code) or prints invalid JSON is a non-blocking error and the dialog still appears. One specific exit code is a blocking deny. | PARTLY REFUTED: exit 2 is NOT honored for this event (flow unchanged), so there is no blocking exit code; other non-zero is non-blocking and the action "proceeds" unless the hook sets `onFailure: "block"`, which denies (deskmates never sets it). Meaning of "proceeds": SPIKE S2 | A crash could deny or allow silently (R2, 3.5). |
| A5 | A hook timeout exists, has a default, is configurable per hook, and on timeout the dialog appears (no implicit allow or deny). | VERIFIED: `timeout` in seconds, default 600, per hook; on timeout the hook is cancelled and output discarded. Dialog afterwards: SPIKE S1, S2 | 3.5, X5, R3. |
| A6 | Order: whether the hook runs before the dialog (blocking it until the hook returns or times out) or in parallel with it, and whether answering in the terminal cancels the hook process. | SPIKE S1 (not stated; the most important spike) | Changes wedge risk (R3), stale entries (X6) and whether "hook slow" delays the user. |
| A7 | Precedence: whether a hook allow can override a `deny` or `ask` permission rule, including managed/enterprise settings. | VERIFIED: rules evaluate deny, then ask, then allow; a hook allow does not override a matching deny rule; managed settings have top precedence. Contract test S11 still required | If it could, deskmates must never emit allow for calls a rule denies (R1, I7). |
| A8 | Multiple hooks for one event run in parallel and results merge in a defined way (for example deny beats allow); a foreign hook that returns allow wins or loses. | PARTLY VERIFIED: hooks for one event run in parallel; how PermissionRequest decisions combine is not stated: SPIKE S3 | I6, R1. |
| A9 | Hook configuration is read at session start (or reloaded live); changes to settings.json may need a restart or a trust review. | SPIKE S6 (docs say only that a watcher normally picks up file edits) | Install/uninstall timing (I4); running sessions keep calling a removed hook. |
| A10 | Claude Code shows a review or trust prompt for new project-level hooks. | SPIKE S6 (not stated) | Project-local install is riskier (I5). |
| A11 | Subagent tool calls trigger `PermissionRequest` and the payload identifies the subagent or not. | PARTLY VERIFIED (`sub-agents`): hooks apply inside subagents and background subagent prompts surface in the main session naming the subagent. `agent_id` in the payload: SPIKE S8 | Multi-session and subagent confusion (D8). |
| A12 | An `http` hook type exists, can POST to a loopback URL, supports headers (and env interpolation), and a failure is non-blocking. | PARTLY VERIFIED: http type exists, POSTs the event JSON, `$VAR` in headers only for `allowedEnvVars`, `allowedHttpHookUrls` restricts URLs, non-2xx or connection failure is non-blocking. It cannot carry a per-run secret into a running Claude Code, so the command hook stays the default. Localhost allowed: SPIKE S12 | If true it removes the script but puts a secret in settings.json (I8); if false the command hook is the only path. |
| A13 | The payload does not carry pid, tty or terminal identity; the hook process can find the Claude Code pid by walking its parent chain. | First half VERIFIED (none documented; command hooks have no controlling terminal; env vars are `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_BRIDGE_SESSION_ID`). Parent chain: SPIKE S4 | Jump-to-terminal (J1-J3) reliability. |
| A14 | The hook runs as the same user, with the project directory as cwd and the user's environment. | SPIKE S5 (`CLAUDE_PROJECT_DIR` is documented; cwd, shell and env are not stated) | Secret handling (H3), I5. |
| A15 | Output may include fields beyond allow/deny (for example an input rewrite, or "remember this rule" permission updates). | VERIFIED: allow may carry `updatedInput` (replaces the whole input) and `updatedPermissions`; deny may carry `message` and `interrupt`. deskmates emits none of them (SPEC R1, R34); see persistence (3.9) | deskmates must never emit them. |
| A16 | settings.json location precedence (user, project, project-local, managed), tolerance of comments or trailing commas, and whether the file is watched live. | Precedence VERIFIED: managed > `--settings` > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`; hooks merge across levels; `disableAllHooks` exists. Comments, trailing commas, live watch: SPIKE S6 | Byte-identical edit and uninstall (I1-I3). |
| A17 | Permission modes (for example accept-edits, bypass) skip the dialog and therefore the hook. | SPIKE S8 (not stated) | The UI must not imply it sees every action (D9). |

## 1. Scope, assets, actors, trust boundaries

In scope: consented hooks install and uninstall, hook to server ingest, display of a request in the browser, browser decision, server answer to the hook, jump to terminal. Out of scope: LAN mode (not allowed in v0.2), replay and export, cost.

### Assets

| Asset | Why it matters |
|---|---|
| User's machine and account | Approve is code execution as the user. |
| Repos and secrets on disk (`.env`, SSH keys, cloud creds) | What an approved command can read or send. |
| Hook script (`~/.deskmates/hook/...`) | Runs on every permission request, as the user, outside the browser. |
| `~/.claude/settings.json` and project settings | They decide which hooks run. A bad edit breaks or hijacks every session. |
| Decide capability (new) | The only thing that turns a browser click into an allow. |
| Ingest secret (new) | Lets a process create requests. Must not be able to decide. |
| Read token (v0.1) | Reads office state (paths, tool names). Must not be able to decide. |
| Pairing code and launch nonce (new) | Bootstrap secrets; short-lived. |
| Audit log | Evidence after an incident; must not become a secret store. |

### Actors

| Actor | Capability | Typical vector |
|---|---|---|
| Malicious web page | Runs JS in the user's browser, can reach loopback | CSRF, cross-origin WS, DNS rebinding, clickjacking |
| Other local user | Can connect to 127.0.0.1, can run `ps` | Read launch URL, guess token, read files if modes are loose |
| Other process, same user (incl. malware) | Same uid: can read user files, edit settings, kill processes | Out of reach of any local design; limits what we can promise (residual R-A) |
| Repo author | Plants `.claude/settings.json`, hooks, CLAUDE.md, MCP config in a repo the user opens | Foreign hooks, spoofed requests, hostile tool_input |
| Prompt-injected model | Controls `tool_input` text, can run any command already allowed, can read files the user can | Self-approval, social engineering in the displayed command, reading deskmates files |
| Compromised dependency | Code execution inside the server or build | Approve anything, read transcripts |
| Shoulder-surfer or screen-share viewer | Sees the screen and notifications | Secret leak, learns when the user is not looking |
| The user | Tired, rushed, trusts the UI | Approves the wrong thing |

### Trust boundaries

```
 [Web pages / other origins]        [other local users]      [repo planted config]
        |  (B1 browser SOP + our    |  (B2 loopback + secrets)        |
        |   Host/Origin/Fetch-Site) |                                 | (B6 foreign hooks)
        v                           v                                 v
+--------------------+   B3 same-origin page   +------------------------------------+
| Browser tab:       |<----------------------->| deskmates server 127.0.0.1         |
| deskmates page     |  WS (read token,        |  request state machine             |
| holds: read token, |  decide grant bound     |  audit log, runtime file (0600)    |
| decide grant (RAM) |  to this WS connection) |                                    |
+--------------------+                         +----------------^-------------------+
                                                  B4 ingest     |  long-poll answer
                                                  (ingest secret)|  (same socket)
                                               +----------------+-------------------+
                                               | hook script (0700 dir, hash logged) |
                                               +----------------^-------------------+
                                                  B5 stdin/stdout JSON (A2, A3)
                                               +----------------+-------------------+
                                               | Claude Code (user's terminal)       |
                                               +------------------------------------+
 Untrusted data crossing B3/B4: tool_input (model-controlled), cwd, session_id, any JSON from the hook.
```

Key trust facts: the browser origin is protected only against browsers (Origin and Sec-Fetch headers are forgeable by any local process); local processes are protected only by secrets; the model controls everything inside `tool_input`.

## 2. Flow tables

Columns: Pre = preconditions. L/S = likelihood / severity. MUST = design requirement. Test = the test that proves it. "Ref" points to a section 3 deep dive.

### 2.1 Install and uninstall (consented hooks)

| ID | Threat | Pre | Impact | L | S | MUST | Test |
|---|---|---|---|---|---|---|---|
| I1 | Installer corrupts or reformats settings.json, drops foreign hooks or comments | Any user with existing hooks or JSONC (A16) | Other tools' hooks vanish; Claude Code fails to load settings | M | High | The installer MUST parse with a tolerant parser and edit by minimal text patch, not re-serialise; MUST show a unified diff and require an explicit yes; MUST write a timestamped backup and use write-temp then atomic rename; MUST abort if the file changed between read and write (mtime+size+hash recheck). Ref 3.6 | Fixtures with comments, trailing commas, foreign hooks, CRLF, no trailing newline; assert only our lines differ; kill -9 mid-write leaves old or new file, never partial |
| I2 | Uninstall leaves a dead entry, or removes the user's own lookalike entry | User deleted script; user hand-edited our entry | Every permission request errors | M | High | Entries MUST carry a marker (a `deskmates:v1` token inside the command string) and uninstall MUST remove only marked entries; the command MUST be self-healing (missing script means exit 0 within 100 ms; see 3.5) | install then uninstall is byte-identical on 20 fixtures; delete script then run a stub Claude Code: exit 0, no output |
| I3 | Concurrent edit lost (user or another tool saves settings.json during install) | Editor open, or Claude Code writes settings | Lost user edits | M | Medium | Recheck-before-rename (I1); on conflict MUST abort with no change and say so | Race test: mutate file between read and rename; assert no write and clear error |
| I4 | Install changes nothing for running sessions, or uninstall leaves running sessions calling the hook (A9) | Sessions started before the change | Mismatch between UI ("hooks on") and reality | H | Low | UI MUST show per-session "hook seen" status from actual ingests, never from settings.json alone; uninstall MUST print that running sessions need restart if A9 says so | Stub: install while a session runs; UI shows "not yet" until first ingest |
| I5 | Project-local install writes a committed file (`.claude/settings.json`) containing an absolute path and marker, shipping it to teammates, or a repo supplies its own entry that mimics the marker | User picks project scope; hostile repo | Teammates run a missing hook (self-heal covers) or hostile repo claims our marker so uninstall deletes ours/keeps theirs | M | Medium | Default scope MUST be user-global or the untracked local-settings file; MUST refuse to write to a git-tracked settings file without a second explicit flag; uninstall MUST match marker plus exact expected path, not marker alone | Install in a repo with tracked settings: refuses; marker with wrong path is left alone |
| I6 | Foreign hooks (repo or user) also answer PermissionRequest and auto-allow, defeating or mimicking deskmates | Repo author, other tools (A8) | UI shows "waiting" while something else already allowed, or user believes deskmates gated an action it did not | M | Medium | `doctor` and install preview MUST list every other PermissionRequest hook found in all settings layers and warn; MUST NOT claim "deskmates gates this" | Fixture with a foreign allow-all hook: install preview warns |
| I7 | A deskmates allow overrides the user's deny/ask rules (A7) | Rules exist, hook returns allow | Silent bypass of the user's own policy | L | High (precedence verified: a hook allow does not override a deny rule; residual risk is Claude Code changing this, R-G) | The browser can never approve a rule-denied call, because Claude Code evaluates deny first. The UI MUST NOT claim deskmates gates or overrides anything. Not needed for rule precedence, but approve stays gated by spikes S1, S2 and S3 (dialog order, crash semantics, foreign hooks) and by contract test S11 against the installed Claude Code | Contract test against real Claude Code: deny rule plus browser allow: call still denied |
| I8 | If the `http` hook type is used (A12), the ingest secret sits in settings.json (readable by agent, backups, dotfile repos) | A12 true | Secret leak to repos and the model | M | Medium | Command hook is the v0.2 default. If http is added, the secret MUST come from an env var or file reference, never inline, and the backup copy MUST be 0600 | grep settings and backups for the secret after install |
| I9 | Installer or hook download/exec from network, postinstall scripts | Compromised dependency | Persistent foothold | L | High | Hook script MUST ship inside the package, MUST be dependency-free, MUST be copied (not downloaded); no postinstall; installer MUST need an interactive yes (no `--yes` default) | CI: install under blocked network; package contains no install scripts |
| I10 | Script or hook swapped after startup, or a hostile repo's `.claude/settings.json` carries an allow-all `PermissionRequest` hook | Repo author, same-uid process | Approve believed to gate while another hook already allows; tampered script runs | M | High | Recheck script hash, inode and mtime on every admission; scan the payload cwd's two project settings files for foreign `PermissionRequest` hooks per request, disable Approve and show a banner (SPEC R63) | Swap script after start; repo with allow-all hook |
| I11 | Text patch lands in a key a last-wins parser shadows (duplicate keys); tracked-file check fooled by a symlink; backups hold `env` secrets | Hostile or odd settings file | Hook not installed or installed in the wrong place; secret copies | L | Medium | Refuse on duplicate keys at any touched level; git-tracked check follows symlinks; backups 0600 in a 0700 dir and uninstall offers deletion (SPEC R64) | Duplicate-key and symlink fixtures; mode assertions |
| I12 | Test tooling supply chain: Playwright (new dependency) runs install scripts and downloads browser binaries | Compromised package | Foothold on dev and CI machines | L | High | Exact pin in a private workspace package outside the published tarball; browsers via an explicit CI step; `--ignore-scripts` with allowlist; harness job holds no secrets (SPEC R65) | Tarball has no install scripts |
| I13 | Control runs against a Claude Code version whose hook semantics changed | Claude Code update | Wrong assumptions about precedence or dialog order | M | High | Control only on a shipped tested-version list; version from the watcher's transcript `version` and `claude --version` in doctor; unknown means off (SPEC R75) | Unknown-version fixture |

### 2.2 Hook to server ingest

| ID | Threat | Pre | Impact | L | S | MUST | Test |
|---|---|---|---|---|---|---|---|
| H1 | Web page POSTs a forged request to the ingest endpoint | Any web page, user browsing | Fake Needs-you, spam, UI confusion | M | Medium | Ingest MUST require the ingest secret in a custom header, MUST require `Content-Type: application/json`, MUST reject any request carrying a browser `Origin` or `Sec-Fetch-Site` header (browsers always add them; the hook never does), MUST keep Host check | Browser harness POSTs to ingest cross-origin and via rebound host: 403 and no state |
| H2 | Local process or agent with the ingest secret forges requests that look like another session ("Claude wants rm -rf, session X") to social-engineer | Same-uid process (reads runtime file) | Misleading prompt; the answer only returns to the forger | M | Medium | The decision MUST only ever be delivered to the connection that created the request (R4); the UI MUST label requests as "hook-reported" with the cwd and session id, never as verified; ingest secret MUST NOT grant read or decide | Two clients: A creates request, B tries to decide with A's id and ingest secret: refused |
| H3 | Ingest secret readable by `ps`, other users, or the model | Secret in argv or env or loose file mode | Ingest abuse (H2) | M | Medium | Secret MUST live in `~/.deskmates/run/ingest.json`, dir 0700, file 0600, written atomically on server start, never in argv or env; hook reads it from disk; rotate on every server start | `ps` and `/proc` scan during a hook call finds no secret; stat modes asserted; second user cannot read |
| H4 | Malformed, huge or hostile payload (JSON bomb, 100 MB tool_input, invalid UTF-8, deep nesting) | Prompt-injected model controls tool_input size (A13) | Server memory or CPU exhaustion, parser crash | M | High | Body cap (for example 1 MiB; over it the request is recorded as "too large to display", terminal only); depth and key limits; the parser MUST NOT throw out of the handler; bad payload returns "no decision" within 1 s | Fuzz and size tests; server RSS bounded; hook still exits 0 |
| H5 | Request flood (model loops tool calls, or forger) | Any ingest holder | UI unusable, approve fatigue | M | Medium | Max pending per session and globally (for example 5 and 20); excess is auto "no decision"; per-second rate limit; UI coalesces | 1000 requests/s: server stable, only caps queued |
| H6 | Server is down, wrong port, stale runtime file points at another program | Server crashed; port reused by an attacker app | Hook sends request (and secret) to an attacker listener | L | High | Hook MUST connect only to 127.0.0.1, MUST send the secret only after the server proves identity (challenge: server returns an HMAC of a hook-supplied nonce using the ingest secret; hook sends payload only if it verifies), MUST time out connect in under 500 ms | Fake listener on the recorded port: hook sends no payload and exits 0 |
| H7 | Request contains tool_input that is also in the transcript | Always | Duplicate sensitive text stored | L | Low | Server MUST hold tool_input in memory only, drop it when the request ends, and MUST NOT write it to disk or logs | grep logs, audit file, cache after a run with a seeded fake key |
| H8 | Ingest socket takeover: a model with any allowed Bash call unlinks `ingest.sock`, binds its own, reads `ingest.json`, answers every hook with a valid MAC and allow | Same-uid process | Silent self-approval of every call Claude would ask about | M | Critical | Server holds the inode, `lstat` every 1 s and before each verdict, on change disable control and alarm (detection only, SPEC R55, R68); residual stated in R-A | T-socket-takeover |
| H9 | Canonical hash ambiguity: unsafe integers, duplicate keys, lone surrogates, `__proto__`, UTF-16 sort order; audit hash prefix confirms guessable commands | Prompt-injected model | Distinct inputs hash equal, or a logged prefix leaks a command | L | Medium | Unsupported inputs answered `none`; sort by code point; no hash prefix in the audit log (SPEC R66, R52) | Test vectors with astral keys |
| H10 | Socket path hygiene: symlinked `run/`, loose `~/.deskmates`, stale-socket unlink steals a live server's path, `ingest.json` pre-created | Same-uid or other-user process | Secret exposure, hijack | L | High | `~/.deskmates` 0700; `lstat` and `O_NOFOLLOW`; probe-connect before unlink; `O_EXCL` 0600 (SPEC R67, R68) | T-socket-hygiene |
| H11 | Payload `transcript_path` points at an arbitrary file and the server opens it for corroboration | Forger, model | Arbitrary file read | M | High | Read only transcripts the watcher found under the Claude projects root; never open the payload path (SPEC R62) | Path to a sensitive file is never opened |
| H12 | Node inspector opened by `kill -USR1 <server pid>` on 127.0.0.1:9229; attacker evaluates code in the server and reads grants or calls the compare-and-set | Same-uid process | Full control of the server | M | High (same-uid ceiling applies; cheap to remove) | Start without SIGUSR1 inspector activation, refuse control when `inspector.url()` is set at any admission, doctor checks (SPEC R70) | T-inspector |
| H13 | Shell wrapper defeats cancel detection: Claude Code kills the shell, Node is orphaned, the socket stays open, the request stays PENDING and Approve reports "sent" to nobody | Terminal answered first, timeout | Ghost request, false "sent" | M | Medium | `exec` node in the command; hook exits when its parent pid changes; heartbeat every 2 s; 6 s silence means ORPHANED; UNVERIFIED until S1 (SPEC R74) | T-orphan |
| H14 | Second deskmates instance unlinks the first's socket; script upgrade breaks the hash check or leaves old script running | Two terminals, release upgrade | Hooks reach the wrong server, control refused or stuck | M | Medium | Instance lock; second instance passive; upgrade shows script-only diff, known-hash list (SPEC R73, R76) | T-instance-lock, T-upgrade |

### 2.3 Server to browser display

| ID | Threat | Pre | Impact | L | S | MUST | Test |
|---|---|---|---|---|---|---|---|
| D1 | Displayed command differs from what runs (paraphrase, summary, LLM description) | Prompt-injected model | User approves a different action | H | Critical | UI MUST render the raw `tool_input` fields from the hook payload, never a summary or `description` as primary text; the same server-held bytes are hashed (X2) and shown. Ref 3.7 | Property test: rendered text equals escaped payload for fuzzed inputs; hash shown equals hash bound |
| D2 | Unicode tricks: bidi overrides, zero-width, homoglyphs, ANSI/control codes, carriage return, tag characters | Prompt-injected model, hostile repo | Command looks safe but is not | H | High | Renderer MUST make every non-printable, bidi (U+202A-202E, U+2066-2069), zero-width (U+200B-200F, U+2060, U+FEFF), tag (U+E0000 block), variation selector, ESC and C0/C1 control visible as a marked escape (for example `<U+202E>`); non-ASCII in a command or URL MUST raise a "non-ASCII: N characters" badge with a codepoint view; `\r` and newlines MUST render as line breaks with line numbers. Review addition: also escape NBSP, U+3000, U+2028/2029, U+2800, U+3164, every other Zs/Zl/Zp/Cf and combining marks, i.e. every code point outside printable ASCII unless in an allowlisted script run; lines MUST wrap with no hidden horizontal scroll (SPEC R59). Ref 3.7 | Corpus of 40 crafted strings (trojan-source samples, Cyrillic lookalikes, `\e[2K`, `\r` overwrite); assert each marker present and the visible text equals the visible-escaped form |
| D3 | Long command hides the dangerous tail | Prompt-injected model | Approve after reading only the start | H | High | No truncation of what the approve button covers without the user opening it: show head and tail plus length and line count; if over 2000 characters or 40 lines, approve MUST stay disabled until the full text is expanded and scrolled to the end, and over 16 KiB approve is terminal only | Command with benign 5 KB prefix then `curl ... | sh`: approve disabled until expanded; tail visible in collapsed view |
| D4 | Non-Bash tools displayed poorly (Edit/Write path and content, WebFetch URL, MCP tool args) | Any tool request | Approve a write to `~/.claude/settings.json`, shell rc, `.git/hooks`, or a hostile URL | M | High | "No renderer, no approve": browser approve MUST exist only for tools with a complete renderer (Bash, Edit, Write, WebFetch in v0.2); others and all MCP tools show full pretty-printed JSON plus server and tool name and are terminal-only until a renderer exists. Edit/Write MUST show absolute realpath and flag paths outside cwd and sensitive targets (settings, hooks dir, `~/.deskmates`, shell rc, `.ssh`, `.git/hooks`, CI files). WebFetch MUST show full URL with userinfo and punycode decoded | Table-driven renderer tests per tool; sensitive-path flag tests; unknown tool is terminal only |
| D5 | XSS: transcript or tool text rendered as HTML next to approve | Any hostile text | Page script reads the decide grant and approves anything | M | Critical | No `innerHTML`/`insertAdjacentHTML`/`document.write` anywhere (lint rule, failing CI); `require-trusted-types-for 'script'` plus current CSP; no inline script or style; no eval; no third-party script; text via `textContent` only | Payload fixtures (`<img onerror>`, `javascript:`, SVG, template literals); Playwright asserts no execution and no DOM node created from text; CSP header snapshot test |
| D6 | UI redress: clickjacking, button swap under the cursor, overlay | Malicious page opens us in an iframe or pops a window over ours; a new request arrives as the user clicks | User approves request B thinking it is A | M | High | `frame-ancestors 'none'` and `X-Frame-Options: DENY` (present in v0.1, MUST be tested on the decide page); the decision message MUST carry the requestId and hash of what was on screen (X2); the approve control MUST be disabled for 600 ms after any change of the displayed request, after window focus and after visibility change; no auto-focus on approve; Enter and Space MUST NOT approve | Iframe test in 3 browsers; synthetic click 100 ms after request swap is ignored; decision for B is not accepted when A was displayed |
| D7 | Notification and screen-share leakage | Notifications on, screen share, recording | Command text, paths or keys leak | M | Medium | OS notifications MUST say only "a session needs you" (no tool, no command, no path); a "hide details" toggle blurs the decision panel and keeps approve disabled while on; redaction MUST NOT rewrite the displayed command (it would break D1), only CSS blur | Notification payload snapshot contains no tool_input text; blur mode disables approve |
| D8 | Multi-session and subagent confusion | Two sessions in one cwd; subagent requests (A11) | User approves in the wrong context | M | High | Each request MUST show session title, cwd, git branch, agent (main or subagent type and parent) and the terminal identity when known; sessions in the same cwd MUST be disambiguated (short session id, started time); requests are never merged or reordered under the cursor | Two sessions same cwd: both labelled and distinct; request ordering stable |
| D9 | UI implies coverage it does not have (modes that skip dialogs A17, sessions without hooks) | Bypass/accept-edits modes | False sense of safety | M | Medium | Per-session badge "hooks active / not seen / mode skips prompts"; docs state deskmates is not a sandbox | Stub: session in a skipping mode shows the badge |
| D10 | Display of a request already resolved elsewhere (terminal answered first, session ended) | Race with terminal (A6) | Click on a ghost, approve applied to nothing or to the next request | M | Medium | Server MUST drop the entry on hook disconnect, session end or timeout and push removal; decisions for non-pending requests return 409 and render "already handled" | Answer in stub terminal first, then click: 409, no effect on next request |
| D11 | Card shows only `command`; other `tool_input` keys such as `dangerouslyDisableSandbox`, `run_in_background`, `timeout` change what approval means | Prompt-injected model | Approve runs unsandboxed or in the background | H | High | Render every key; per-tool allowlist; an unknown key or `dangerouslyDisableSandbox: true` shows a red flag and disables Approve (SPEC R57) | Unknown-key corpus |
| D12 | Card shows the session `cwd` but Bash keeps `cd` between calls, so the command runs elsewhere | Prompt-injected model | User misjudges blast radius | M | Medium | Label cwd as the session directory with the caveat (SPEC R77) | Label present |

### 2.4 Browser to server decide

| ID | Threat | Pre | Impact | L | S | MUST | Test |
|---|---|---|---|---|---|---|---|
| X1 | CSRF or cross-origin fetch/form/WS from a malicious page | User has deskmates running and visits any page | Remote code execution via agent | M | Critical | Decide MUST be one WS message type (or one POST) requiring: exact Host; `Origin` present and exact; `Sec-Fetch-Site` exactly `same-origin` (v0.1 only refuses `cross-site`, which is too weak here: absent, `same-site`, `none` must all fail); JSON content type; the decide grant (X3). Cookies are never used | Spoofed Host, `Origin: https://evil.com`, `null` Origin, missing Origin, `Sec-Fetch-Site: same-site`/`none`/absent, form-encoded, text/plain, preflight: all fail and the state is unchanged |
| X2 | Decision applies to a different request or different input than shown | Race, replay, injected swap | Approves unseen action | M | Critical | A decision MUST name `requestId` (128-bit random) and `inputHash` (SHA-256 of canonical tool_input as held by the server); the server MUST compare to the pending entry and the displayed hash and refuse on any mismatch. Ref 3.4 | Wrong id, wrong hash, hash of different input, id from another session |
| X3 | The read token (or a leaked page capability) can decide | Token read by any local process, page script, or `ps` launch window | Read-only attacker becomes executor | M | Critical | Separate decide grant. Ref 3.2. The read token MUST be refused on decide even if every header is right | Read token plus perfect headers on decide: 403; decide grant on read endpoints: refused |
| X4 | Double decide / double click / two tabs | Normal use | Two decisions race | H | Medium | Atomic compare-and-set pending to decided; second decide returns 409; only the first changes state and is audited | 50 parallel decides for one request: exactly one wins |
| X5 | Decide after timeout lands on the next request or does nothing visible | Slow user | Wrong action or silent loss | M | High | Expired requests are terminal and never reused; ids never reused; UI shows "expired, answer in terminal" | Decide after expiry: 410; next request unaffected |
| X6 | Decide after session end or after the terminal already answered | Race (A6) | Ghost decision | M | Medium | Hook socket closed means request `superseded`; decide returns 410 | Close socket then decide |
| X7 | Decide arrives over a WS opened without verified Origin (non-browser client) | v0.1 allows missing Origin on upgrade | Local process decides with a stolen grant | M | High | Decide MUST only be accepted from a connection whose upgrade had a present exact Origin and `Sec-Fetch-Site: same-origin`, and that holds a grant bound to that connection (X3). Missing Origin is fine for read, never for decide | curl/ws client with token and forged Origin but no grant: no decide |
| X8 | Decide mode on by default | Any install | Larger blast radius for everyone | M | High | Default is report-only. Browser approve is an explicit per-run opt-in made out of band (terminal command or flag), auto-expires after 30 min idle, shows a banner while on. Ref 3.2 | Fresh start: decide refused; enable in terminal: works; after idle: refused |
| X9 | Replay of a captured decide message | Loopback sniffing (needs root) or log leak | Re-approve | L | Medium | Single-use per request (X4); grant bound to WS connection and rotated on reconnect; messages carry a monotonically increasing counter | Replay on new connection and after decision: refused |
| X10 | Brute force or guessing of ids, nonce, pairing code | Local process | Bypass | L | Medium | 128-bit ids; nonce 128-bit single use 30 s; pairing code rate-limited (3 tries then lockout, new code); constant-time compares; all failures counted and shown in status | Attempt budget test; lockout works |
| X11 | Read token (launch URL) and pairing code are printed where an agent can read them (tmux `capture-pane`, `script`); headless WS client forges Origin and Sec-Fetch-Site, pairs, opts in and approves | Prompt-injected model with terminal read access | Full approve authority | M | Critical | Launch URL and code only to `/dev/tty`; refuse pairing under `TMUX`, `STY` or non-TTY stdout without an explicit flag (SPEC R56); state the residual plainly | T-tty-only |
| X12 | Pairing code reusable by a second tab within 60 s; attempts shared across all connections so any local client burns the user's code | Local process | Unauthorized grant, or denial of pairing | M | High | Single-use code; per-connection attempts first, global cap; tell the user on the terminal when it was burned (SPEC R58) | Second tab reuse; burn test |
| X13 | An extra controller pairs unnoticed (code read from the terminal, second tab) | Local process with terminal read | Silent extra decide authority | M | High | Page shows N controllers paired; every grant prints a terminal line with time, connection id, Origin (SPEC R71) | T-controllers |
| X14 | A forger fills the pending cap of an opted-in session (session ids are readable) so real requests get `none`; a flood keeps re-arming the 600 ms dwell so Approve never enables | Same-uid forger | Denial of control, approval fatigue | M | Medium | Evict not-seen requests first; background arrivals never re-arm the displayed card; global rate limit (SPEC R72) | T-fairness |

### 2.5 Server to hook response

| ID | Threat | Pre | Impact | L | S | MUST | Test |
|---|---|---|---|---|---|---|---|
| R1 | Hook emits allow when it should not (policy bypass A7/A8, bug) | Logic error | Silent allow | M | Critical | The hook MUST print an allow only when the server returned a verified `allow` for that request (HMAC over requestId, inputHash and verdict, using the ingest secret); everything else prints nothing and exits 0. It MUST never emit input rewrites or permission updates (A15). Ref 3.9 | Golden outputs: only 3 shapes (nothing, allow, deny); no extra keys; fuzz server replies |
| R2 | Server returns garbage, wrong id or a response for another request | Compromised or buggy server, port squatter (H6) | Wrong verdict | L | High | Hook MUST verify the HMAC and id echo; mismatch means no decision | Fake server returns allow without a valid MAC: hook prints nothing |
| R3 | Hook hangs and wedges the session | Server hung, socket half-open | Claude Code blocked up to its timeout (A5/A6) | M | High | Hook MUST enforce its own total deadline shorter than Claude Code's configured timeout (default wait 25 s, hook timeout set 30 s, both configurable; verify A5), connect timeout 500 ms, and exit 0 on any error. Ref 3.5 | Black-hole server; assert hook exits 0 at deadline; wall-clock bound test |
| R4 | A decision is delivered to a different connection or two hooks | Same-uid forger | Request answered for the wrong process | L | Medium | One request, one socket; the answer goes only on that socket; socket close cancels | Two requests, verify cross-delivery impossible |
| R5 | Verdict "deny" or "interrupt" misused to deny-of-service or to override user rules | Compromised page | Annoyance, loss of agent work | M | Low | Deny is a hook "deny" with a fixed neutral message; no "interrupt" semantics in v0.2; user can always answer in terminal if hook was no-decision | Contract test |
| R6 | A captured verdict MAC is replayed: the replier chooses the request id | Same-uid process, port or socket squatter | Replayed allow accepted by another request | L | High | MAC also covers a fresh per-request hook nonce (SPEC R61) | Replay allow with a different nonce |
| R7 | Hung server: a Unix connect succeeds from the kernel backlog, so the 500 ms connect timeout does not help and every prompt stalls for the full wait | Hung or SIGSTOPped server | Every permission prompt delayed up to 28 s | M | High | Server acks `held` or `none` within 500 ms; the hook exits 0 if no ack (SPEC R60) | SIGSTOP the server |

### 2.6 Jump to terminal

| ID | Threat | Pre | Impact | L | S | MUST | Test |
|---|---|---|---|---|---|---|---|
| J1 | Jump focuses the wrong terminal (same cwd, tabs, tmux) | Payload has no tty (A13 verified); parent-chain pid unproven (SPIKE S4) | User types an answer into the wrong session | M | High | Jump only when pid/tty was captured by the hook from its parent chain and still matches a live process; otherwise show "unknown, find it by session id and cwd"; never guess by cwd | Two sessions same cwd: correct or "unknown", never wrong |
| J2 | Command injection through osascript/AppleScript or shell strings built from tty, title, cwd | Hostile cwd or session title (model/repo controlled) | Code execution on click | M | Critical | No shell, no string-built scripts: use `execFile` with an argument vector; pass identifiers via argv to a fixed script; validate tty against `^/dev/ttys?[0-9]+$` and pid as integer; titles never reach a script | cwd named `"; do shell script "touch /tmp/pwn"`: no file created; fuzz identifiers |
| J3 | Jump is a state-changing endpoint without the decide gates | Malicious page calls focus | Window focus theft, phishing overlay timing | M | Medium | Jump MUST use the same Host/Origin/Fetch-Site rules and a grant (read token is not enough: it moves the user's focus); rate limit 1 per second | Cross-origin focus fails; rate limit |
| J4 | Jump raises a terminal and a key press then lands in a prompt | UI has Enter bound | Unintended answer | L | Medium | Jump never sends keystrokes. It only focuses | No keystroke API in the module |
| J5 | macOS Automation permission prompt trains the user to click through | First use | Consent fatigue | L | Low | Explain before first use; feature is optional and off if refused | Manual |

## 3. Deep dives

### 3.1 DNS rebinding and the real-browser harness

Why tests that send a forged `Host` are not enough: they prove the server's check, not the browser's behavior (for example Origin on a rebound WebSocket, cached DNS, `localhost` resolving to `::1` first, trailing-dot hostnames, `Host` casing, port omission).

Harness, two tiers:

- Tier 1, blocking on every PR. Playwright, Chromium and Firefox (WebKit as best effort, see below). The deskmates server runs on a fixed loopback port. An "attacker" static server runs on a second port. The attacker hostname `evil.test` is mapped to 127.0.0.1 inside the browser (Chromium: host resolver rules; Firefox: local-domains pref; WebKit: only where an `/etc/hosts` entry is possible, such as the Linux CI container). That reproduces the post-rebind state deterministically: the page origin is `http://evil.test:PORT`, the target is the deskmates port, and `Host` carries `evil.test`. The attacker page runs a script that tries: fetch GET with and without custom headers, fetch POST JSON (forcing a preflight), form POST, WS upgrade with and without subprotocol, WS decide frame, ingest POST, iframe embed, window.open. The same script also runs from `http://localhost:OTHER_PORT` (same host, other port) and from `file:` and `null` Origin. Flags that relax private-network protections MUST be set in the harness so the test proves our server stands on its own; flag names are looked up at implementation time per browser version.
- Tier 2, nightly (not blocking, alerts). Real rebinding: a small DNS responder (in a container, TTL 0) answers `rebind.test` with a non-loopback address first and 127.0.0.1 after the first query; the page waits for the flip and repeats the attacks. Where a browser cannot be pointed at the custom resolver in CI, document the gap rather than skip silently.

Pass criteria, per attack: (a) the browser-side result is a failure, (b) server counters (`rejected[...]`) rose by the expected reason, (c) pending requests and audit log are unchanged. Every run includes a positive control: the legitimate same-origin page, after a valid grant, decides a stub request successfully. A suite with no positive control passes vacuously.

Non-flaky by construction: no sleeps, wait on server-side counters and a fence request (a final legitimate request proves earlier attack frames were processed, since WS and HTTP ordering is observable); fixed ports; pinned browser versions via the lockfile; each attack repeated 20 times in one run because a negative test is only useful if it fails deterministically when the defense is removed; mutation check in CI: temporarily disable each check and confirm the matching attack succeeds (proves the test can fail).

### 3.2 Decide capability, delivery and why a same-origin gesture is not enough

Facts: `Origin`, `Sec-Fetch-*` and `User-Agent` are set by browsers but forgeable by curl; a user gesture exists only inside the page, the server cannot see it; any script in the page can call `button.click()` or send the WS frame without a gesture. So headers stop other websites, secrets stop local processes, and neither stops script injected into our own page (D5). Gesture requirement is a UI-level aid against clickjacking (D6), not a security boundary.

Three secrets, three powers:

| Secret | Held by | Grants | Never |
|---|---|---|---|
| Ingest secret | hook script via 0600 file (readable by any same-uid process) | create requests, receive its own answer; its holder can also answer the hook directly (same-uid ceiling) | read state, decide through the server |
| Read token | page memory | read state over WS and `/api/status` | decide, focus |
| Decide grant | page memory, one per WS connection | decide and focus for pending requests | persisted, in URL, storage, DOM, logs |

Proposed delivery (design option D1; owner may weaken for convenience, see section 4):

1. Decide is off at start. The user enables it from the terminal where deskmates runs (command or flag). The server then prints a 6-digit pairing code to its own stdout, valid 60 s, three attempts.
2. The page asks for the grant over the existing WS: `grant{code}`. The server checks the code in constant time, requires the connection's upgrade to have had a present exact Origin and `same-origin`, and returns a random 256-bit grant bound to that WS connection id. The page keeps it in a closure variable (not a global, not storage, not DOM).
3. Every decide frame carries the grant. Closing the WS, 30 minutes idle, or terminal `decide off` voids it. A reload requires pairing again (accepted friction).

Why a code typed from the terminal: the model is the likeliest hostile party and it runs as the user. It can run `ps`, read files in the user's home and curl loopback, but it cannot read what the server printed to the user's own terminal or what is in browser memory. A file-based or argv-based secret is readable by it. The nonce exchange (3.3) is for read access only.

Residual: script running inside the page (XSS, malicious extension with page access) can read the closure. Mitigated by D5 controls, not removed.

### 3.3 Launch URL in `ps` and the one-time nonce exchange

v0.1 passes `http://127.0.0.1:PORT/#t=TOKEN` to the browser opener, so the read token sits in `ps` for the opener's lifetime. Required for v0.2:

- The launcher MUST pass only `http://127.0.0.1:PORT/#n=NONCE` where NONCE is 128-bit, single use, valid 30 s.
- The page reads the fragment, calls `history.replaceState` to clear it, and POSTs it to `/api/exchange` (same-origin, JSON, Origin present). The server returns the read token and invalidates the nonce on first use, even if the request was malformed after the lookup.
- A second use or an expired use MUST show a loud terminal line ("launch link reused") and a page message, because that is the signal that someone raced the user.
- The nonce route accepts no other credentials and is rate limited.
- Honest limit: a local user polling `ps` every few milliseconds can still win the race in the 30 s window on a slow browser start. Detection (the user's own page fails to pair) plus short TTL is the mitigation; decide authority is separately protected by the pairing code (3.2), so winning the race yields read-only access.

Tests: reuse, expiry, race (two clients, one wins), token absent from `ps` output, nonce absent from logs, token never in URL after load.

### 3.4 Request state machine

```
              ingest ok
  (none) ----------------> PENDING --decide(valid, CAS)--> DECIDED --delivered--> CLOSED
                              |  \--timeout--> EXPIRED -----------------------> CLOSED
                              |  \--hook socket closed / session end ---------> SUPERSEDED -> CLOSED
                              \--server shutdown--> (sockets close; hooks exit 0)
```

Rules:

- IDs are 128-bit random, never reused; the table is in memory only.
- Transitions happen in one synchronous step (no await between read and write of state); only PENDING can move to DECIDED. Anything else returns 409 (decided) or 410 (expired or superseded).
- A decision binds `requestId`, `inputHash` and verdict. The server recomputes the hash from the stored tool_input; the page displays the hash prefix (8 hex) so mismatches are diagnosable.
- Timeout at the server is shorter than the hook's deadline, which is shorter than Claude Code's (A5). On expiry the hook prints nothing: the terminal dialog remains.
- Two simultaneous requests are independent entries; decisions never apply by position or "current". The UI never auto-advances the selected request when one resolves.
- Server crash mid-request: the hook's socket breaks, it exits 0 with no output, Claude Code shows its own prompt (A3, A4). On restart the table is empty; a late decide for an old id returns 410.
- Terminal answered first (A6): hook process may be killed or its socket closed; the server marks SUPERSEDED. A decide that wins the CAS but cannot be delivered is audited as "undelivered".
- No partial decisions, no "allow all", no timers that auto-decide.

Tests: property test over random event orderings (decide, timeout, close, shutdown) asserting at most one terminal state and that an allow is delivered only from DECIDED(allow); kill -9 mid-request with a stub Claude Code; 50-way concurrent decide.

### 3.5 Fail-open versus fail-closed

Principle: any deskmates failure degrades to Claude Code's own prompt. It never degrades to an implicit allow and never to a silent deny. The hook must never wedge a session.

- No decision is the default and the only output on any error: server down, auth failure, challenge failed (H6), timeout, parse error, oversized payload, expired, superseded, decide mode off, unsupported tool (D4), cap exceeded (H5).
- The hook has a hard wall-clock deadline implemented by the hook itself (not only by Claude Code's timeout A5), a connect timeout of 500 ms, and a try/catch around the whole body that ends in exit 0 with empty stdout. No unhandled promise path.
- The install command wraps the script in a guard so a missing or non-executable file exits 0 (I2).
- A hook that cannot reach the server within 500 ms does not retry; the user sees the dialog at normal speed.
- Fail-closed exception, narrow: if the installed hook's hash differs from the recorded hash (3.8), the server refuses decide mode and says so. That is closed for approve, not for the session.
- Test matrix: daemon down, hung accept, slow drip response, garbage body, closed mid-response, wrong MAC, 100 MB body, DNS or IPv6 oddities, missing script, script not executable, node not on PATH (hook runtime resolved at install, recorded, doctor verifies).

### 3.6 settings.json editing

| Concern | Requirement |
|---|---|
| Consent | Show the exact diff and the file path; require an explicit yes at an interactive prompt; `--dry-run` prints the diff and writes nothing |
| Backup | Timestamped copy under `~/.deskmates/backups/` mode 0600 before any write; keep the last 10; never include the ingest secret (I8) |
| Marker | Each command contains `deskmates:v1`; uninstall removes only entries with marker and the exact recorded command |
| Byte-identical uninstall | Edit by minimal text patch (insert and remove whole entries) and record offsets/context in `install.json`; if the file changed since, fall back to a parse-based remove with a diff and consent; test on 20 fixtures |
| Concurrent edit | Hash and mtime recheck at rename time; abort with no change on mismatch |
| Foreign hooks | Never reorder, merge or normalize them; list PermissionRequest foreign hooks (I6) |
| Scope | Default user-global or untracked local file; tracked project file needs an extra flag (I5); managed settings are never touched and are reported if they exist (A7, A16) |
| Atomicity | Write temp in same directory, fsync, rename; preserve mode and symlinks (edit the target, not replace the link) |
| Uninstall also | Removes the hook script and runtime files, or leaves them if other scopes still reference them; `doctor` reports leftovers |

### 3.7 What the user sees

- Primary text is the raw payload field: for Bash the `command` string verbatim (escaped per D2), with working directory and any `description` shown separately and labelled "model-written, untrusted".
- Escaping policy: render in a monospace block with each line numbered; visible-escape every non-printable and bidi/zero-width/tag/ANSI character; show a badge and a codepoint view for non-ASCII; highlight `|`, `;`, `&&`, `$(`, backticks, `curl`/`wget`/`sh`/`eval` only as an aid and never as a claim of safety (no "looks safe" labels). No syntax highlighting that parses the command.
- Truncation: head and tail always shown; length and line count shown; rules in D3.
- Non-Bash tools: D4. Edit shows old and new text; Write shows path and a size, with content expandable; WebFetch shows full URL and method.
- Never shown: model-written reassurance as a header, tool results, redacted rewrites.
- A deliberately dull confirmation: two buttons, deny is first and has focus, approve is a different color with the hash prefix next to it. No countdown pressure; the timeout is shown plainly.
- Display of the same request in notifications, sprites and the queue shows only tool name (D7).

### 3.8 Hook trust

- Location: `~/.deskmates/hook/` created 0700, script 0500 (read-only to the owner), owned by the user; runtime files in a separate `run/` dir 0700.
- The installer records SHA-256 of the script in `install.json` (0600). The server recomputes it on startup and on each decide-mode enable and refuses to enable approve if it differs. `doctor` prints the result.
- If a repo or another process rewrites the script: same uid means nothing can fully prevent it (residual R-A); we detect and refuse decide mode, and we never execute anything from the project directory. The hook MUST NOT read configuration from cwd or project files.
- The hook script is dependency-free (Node built-ins only), at most a few hundred lines, with its source reviewed as part of release. The command uses an absolute path to the runtime recorded at install; no `PATH` lookup at run time beyond that.
- Strictly additive: the hook never prints allow without a verified verdict (R1), never prints rewrite or permission-update fields (A15), and cannot turn a rule-denied call into an allow (I7). It never writes to settings, never spawns processes.

### 3.9 Persistence of decisions

"Always allow", "allow for this session" and rule creation MUST NOT exist in v0.2: no UI, no protocol field, no hook output (A15, A18 style fields are never emitted; a test asserts the output schema). Every approval is a single use bound to one request (X2). Reason: a persistent allow converts one misread into standing remote execution and widens the XSS prize. Revisit in v0.3 with its own threat model.

### 3.10 Audit log and replay

- File `~/.deskmates/audit.jsonl`, mode 0600, append only, size capped with rotation (for example 5 MB, 3 files).
- Fields: timestamp, requestId, short session id, tool name, input hash prefix, verdict (allow, deny, expired, superseded, refused-with-reason), source connection id, latency, delivered yes/no.
- Never: tool_input text, command, paths from input, secrets, the grant, the nonce, the ingest secret.
- Failed attempts (bad Host, bad Origin, bad grant, nonce reuse, pairing failures) are counted in `/api/status` and logged with reason only.
- Tests: seed fixtures with fake keys, JWT, `.env` text, run the full flow, grep audit, logs, cache and status for any of them; assert absent.

## 4. Residual risks the owner must accept, and the ship gate

### Residual risks

| ID | Risk | Why it stays | Owner decision |
|---|---|---|---|
| R-A | Any process running as the user (malware, a compromised dependency, a shell the model already has) can edit settings, replace the hook, kill the server or approve its own actions by other means | Same uid cannot be defended locally; Claude Code's own permissions have the same limit. Concretely, any same-uid process holding the ingest secret (a 0600 file the model can read) can replace the ingest socket and answer allow to the hook, silently self-approving calls (H8, detection only) | Accept, and document "deskmates is not a sandbox" |
| R-B | Script running inside our page (XSS, a malicious browser extension) can read the grant and decide | Browsers give no secret store to a page that is safe from its own scripts | Accept with D5 controls; offer terminal-only mode as the safe default |
| R-C | A user who reads the command and approves a bad one | Approve is a human decision | Accept; mitigated by D1-D4 display rules and no persistence |
| R-D | Prompt-injected model writes a persuasive command or comment | Content is model-controlled | Accept; display rules reduce, not remove |
| R-E | Nonce race in the `ps` window gives read-only access | Opener passes args | Accept (read only), with detection |
| R-F | Pairing friction on each reload | Security over convenience | Owner may relax to per-run (weaker, see X8) |
| R-G | Claude Code semantics change between releases (hook JSON, exit codes, precedence) | We do not control it | Contract tests against the installed version; refuse decide mode on unknown versions |
| R-H | Hook can be bypassed by permission modes or rules that skip the dialog (A17) | By design in Claude Code | Accept; show badge (D9) |
| R-I | Loopback is cleartext; root or packet capture on the host can read it | Local only | Accept |

### Do not ship v0.2 (approve and deny) unless

1. Section 0 assumptions A1-A8, A15 and A16 are verified from official docs (A1, A7, A15 and the precedence half of A16 are already; the rest are settled by spikes S1-S3, S6, S11; A12 is informational via S12 and is no longer a gate, S6 only decides parser tolerance and install wording) and covered by a contract test against a real installed Claude Code (not mocks). A7 is verified from the docs (deny rules win), so approve no longer waits on it; approve stays disabled until spikes S1, S2, S3 and the S11 contract test pass.
2. The Tier 1 rebinding harness runs in CI in Chromium and Firefox with a positive control and a mutation check, and the Tier 2 job exists.
3. Decide uses a separate grant that the read token cannot replace (X3), is off by default (X8), and requires Origin present, `Sec-Fetch-Site: same-origin` and a connection-bound grant (X1, X7).
4. The request state machine passes the property test, the 50-way race, and kill -9 mid-request with a stub Claude Code (3.4).
5. The hook proves fail-open on every case in 3.5, within its own deadline, and prints only nothing, allow or deny (R1-R3).
6. The renderer passes the unicode, length and per-tool corpora; approve is hidden for any tool without a complete renderer (D1-D4); lint bans HTML sinks and CSP plus Trusted Types are snapshot tested (D5).
7. Install and uninstall are byte-identical on the fixture corpus, consent is interactive, and backups work (I1-I3, 3.6).
8. The launch URL carries only a one-time nonce, never the token (3.3), and the nonce route tests pass.
9. Jump uses argv only, no shell, validated identifiers (J2).
10. No "always allow" anywhere (3.9) and the audit log test shows no secrets (3.10).
11. Security review additions hold: socket takeover is detected and alarmed (H8), launch URL and pairing code go to `/dev/tty` only and pairing is refused under multiplexers without a flag (X11), the card renders every key and flags unknown keys (D11), pairing codes are single use (X12), the hook acks within 500 ms (R7), the verdict MAC covers a request nonce (R6), the script hash and foreign project hooks are rechecked per request (I10), and the Playwright dependency is isolated (I12).
12. Second-review additions hold: the slice 1 hook script cannot emit allow or deny (SPEC R69); the inspector cannot be opened by SIGUSR1 and control is refused if it is (H12); transcript corroboration is a badge, not a gate (S7 is informational and not on this list); installs have no silent global default (R14).
13. `docs/SECURITY.md` is updated to match, `pnpm install --frozen-lockfile` stays in CI, no new runtime dependency is added without owner approval, and the live attack run is repeated under Node.

## 5. Test matrix summary

| Area | Rows | Test type | Gate |
|---|---|---|---|
| Header and capability checks | X1, X3, X7, H1, J3 | Server unit plus live attack script | PR |
| Real-browser rebinding | X1, H1, D6 | Playwright, Chromium and Firefox, mutation check | PR (tier 1), nightly (tier 2) |
| State machine and races | X2, X4-X6, D10, R4 | Property and concurrency tests, kill -9 | PR |
| Fail-open hook | R1-R3, H6, cases in 3.5 | Process tests with stub Claude Code and hostile servers | PR |
| Contract with real Claude Code | A1-A17, I7 | Opt-in integration job on installed version | Release |
| Install and uninstall | I1-I9 | Fixture corpus, crash and race tests | PR |
| Renderer | D1-D4, D7 | Corpus tests: unicode, length, per-tool, notification snapshot | PR |
| XSS and UI redress | D5, D6 | Playwright payloads, CSP snapshot, iframe test, dwell test | PR |
| Secrets and logs | H3, H7, 3.10 | Fixture secrets and grep of every output | PR |
| Jump | J1-J5 | Injection fuzz, two-session fixtures | PR |
| Supply chain | I9, R-A | Offline CI run, lockfile, no install scripts, SBOM | Release |
| Residual acceptance | R-A to R-I | Owner sign-off recorded in an ADR | Before ship |
