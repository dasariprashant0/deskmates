# deskmates handoff (2026-10-18)

Tell the new session: "read docs/HANDOFF.md, CLAUDE.md and docs/ROADMAP.md, then continue".

## State

- Repo: `~/Projects/personal/deskmates`, public `github.com/dasariprashant0/deskmates`, default branch `main`, last merge PR 11 (`ff98938`), CI green. The only untracked item is `.claude/` (harness markers, do not commit). This file is also uncommitted.
- v0.1 is feature-complete and merged (PRs 1-11). Nothing is published to npm. No hooks are installed anywhere.
- Packages: `core`, `provider-claude`, `sprites`, `server`, `client`, `apps/cli`. Tests: core 64, provider 82, sprites 187, server 340, client 296, cli 50. All pass; tsc clean.
- Verified live against the user's real `~/.claude/projects` (counts-only smoke: 490 sessions, 0 parse errors): about 13 characters shown, readable tags, `+N idle` hidden count, per-session costs like `~$3.43`, HUD `~$44.46+ est.`.
- Bench (50 sessions, 60 s): CPU about 4%, RSS about 62 MB, 0 gaps.

## What the user wants (standing)

- Real feature branches, small logical commits, a PR per branch with a clear description, merge on GitHub after CI passes, keep branches visible. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; PR bodies end with the Claude Code line.
- Use skills and agents on purpose (see `CLAUDE.md`, `docs/TOOLKIT.md`). Pattern that worked: one implementer subagent per slice, then independent reviewers (security, accessibility, performance), then fixes, then my own verification, then PR.
- Do NOT publish (npm) and do NOT install hooks without an explicit yes. Keep Zuddl and employer data out. Never read private transcript content; the smoke script prints counts only.
- Bring the 10x version of ideas, do not just implement. No employment-contract topics.

## Pending (priority order)

1. **Release prep for v0.1**: real README (it is about 379 bytes), screenshots or a demo GIF, re-run the live attack script (about 110 attacks) under Node (it was run under Bun), `npm pack` dry run, clean-machine install check. Publishing needs the user's explicit yes.
2. **Accessibility follow-up**: test with a real screen reader (NVDA, JAWS or VoiceOver) and 200-400% zoom; compact layout under 640 px; `?` shortcuts overlay; context-window bar and last 5 events on the agent card.
3. **Polish**: sibling subagents share a sprite look (seeded by base name); ordinals count ended agents so can reach `#5` and beyond (a sticky per-session counter is suggested in `packages/client/src/hud/labels.ts`); cost does not model Haiku 5.5 prompts over 100K tokens or 1-hour cache writes; the default price table is a snapshot dated 2026-10-18 (refresh from https://platform.claude.com/docs/en/about-claude/pricing).
4. **v0.2 (approve/deny)**: plan first (spec plus threat model) with the `docs/SECURITY.md` conditions: a separate decide capability and secret (not the read token), same-origin Origin plus a user gesture, the raw command shown from the hook payload, a request state machine with race tests, consented hook install and uninstall with a shown diff and byte-identical uninstall, and a real-browser DNS-rebinding harness BEFORE any state-changing endpoint. Also known: the launch URL (token in the fragment) is passed to the browser opener and is visible in `ps`; fix with a one-time nonce exchange.
5. Later: v0.3 replay, v0.4 redacted export, other providers, desktop wrapper, team/LAN mode (each needs its own threat model).

## Run it

```bash
cd ~/Projects/personal/deskmates
(cd packages/client && node build.mjs) && (cd apps/cli && node build.mjs)
node apps/cli/dist/deskmates.js --no-open --port 7878   # prints http://127.0.0.1:7878/#t=TOKEN
```

Open the printed URL. Add a `?r=N` query when reloading in the same tab, because a fragment-only change does not reload. `/?demo=1` runs the scripted demo with example prices. In the built-in browser pane, press Tab once if the first frame looks blank (the pane pauses painting until focused).

## Environment gotchas

- `pnpm` is blocked in the sandbox: run tests per package with `node node_modules/vitest/vitest.mjs run` and `node node_modules/typescript/bin/tsc -p . --noEmit`. Git writes, `gh`, local ports and the CLI need the sandbox off.
- ECC GateGuard denies the first edit or write of each file, and the first Bash command of a session, until you state the facts it asks for and retry.
- A post-write hook can end a subagent turn right after a test file is written; send a follow-up "implement now".
- `gh` fails inside Monitor (sandbox); wait on CI with a foreground Bash loop over `gh pr checks <n>`.
- Prices: `~/.deskmates/prices.json` merges over the default table per model.

## Where things are

- Design: `docs/ARCHITECTURE.md`, `SECURITY.md`, `DESIGN.md`, `ROADMAP.md`, `TOOLKIT.md`; plan in `docs/superpowers/plans/2026-10-18-deskmates-v0.1.md`.
- Server security surface: `packages/server/src/{security,http,ws,server,redact}.ts`. Client: `packages/client/src/{app.ts,sim,net,hud,render,demo}`. Scripts: `scripts/smoke-real.mjs`, `scripts/bench.mjs`.
- Memory note: `~/.claude/projects/-Users-prashantdasari-Projects-personal/memory/deskmates-project.md`.
