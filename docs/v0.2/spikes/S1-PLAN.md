# Spike S1 plan: is the terminal dialog shown while a PermissionRequest hook waits?

Status: plan only. Nothing here has been run. Every step that starts a real `claude` session needs the owner's yes first (OQ18 approved the scratch-only approach in principle, not each run).

## Why this spike

SPEC section 3 and S1: the docs say a hook can run alongside the host's own prompt ("whichever decides first applies") for host-driven sessions, but do not say whether the TERMINAL permission dialog is shown in parallel with a pending PermissionRequest hook, what happens if the user answers in the terminal first, or how Claude Code kills the hook. The design's wait values (25 s server, 28 s hook, 30 s timeout), R3, R74 and the ORPHANED rule all depend on this.

Pass criterion (from SPEC S1): dialog visible during the sleep; a terminal answer proceeds within 1 s; the hook process is killed or its socket closes within 2 s in 10 of 10 trials, for the timeout case and the terminal-answer case separately.

## What the docs already settled (so the spike need not)

- `--settings` merges ON TOP of user settings. Your global hooks and allow rules still apply unless the user source is excluded. So isolation is mandatory (see below).
- `echo` is a built-in read-only command and never prompts in any mode. The probe needs an `ask` rule and a non-read-only command.
- Interactive sessions start in auto mode from v2.1.283. The spike must pass `--permission-mode default` explicitly.
- Command hooks without `args` run through `sh -c`; the default timeout is 600 s, set with a per-hook `timeout` (seconds); on timeout the hook is cancelled and its output discarded. The kill signal and whether the process group is signalled are NOT documented: that is what S1 measures.
- Interactive mode holds hooks from every settings file until the folder is trusted.

## Isolation recipe (UNVERIFIED end to end, so step P0 proves it before any measurement)

1. Run from a fresh scratch directory under `$TMPDIR` with no `.claude` folder.
2. Launch with `--setting-sources project,local --settings <stub.json> --permission-mode default --model haiku --debug-file <log>` and the probe as the positional prompt. This leaves the login alone (no `CLAUDE_CONFIG_DIR`, no API key, no `setup-token`: credentials are the owner's and stay untouched).
3. `stub.json` contains only the PermissionRequest stub hook and an `ask` rule for the probe command.
4. Leak check (P0): the debug log must show ONLY our stub hook running. Any other `Hooks:` line (a global hook, a plugin hook such as a GateGuard) means the isolation failed; the spike stops and we switch to the fallback.
5. Fallback if leakage appears: `--restricted` (loads only managed settings and `--settings`; removes Bash and WebFetch unless named) with `--tools Bash`. If that also leaks or breaks the dialog, stop and report; do not widen the approach.
6. Before and after every batch: record SHA-256 of `~/.claude/settings.json` and `~/.claude.json` (hash only, never print contents) and report any change.

Side effect that needs the owner's decision: the first interactive run in a new folder shows Claude Code's trust prompt, and accepting it writes a trust entry for the scratch path into `~/.claude.json`. Options: (1) accept it and leave the harmless entry (default), (2) run from an already-trusted folder instead (leaks that folder's project settings unless excluded), (3) skip interactive and use `-p` (cannot observe the dialog, so it does not answer S1).

## Harness (all in a scratch dir, nothing under `~/.claude`)

- A PRIVATE tmux server (`tmux -L deskmates-s1`) so the owner's own tmux is never touched. tmux is only the harness that gives `claude` a pseudo-terminal; it is unrelated to the OQ19 pairing rule. If tmux is missing, fall back to `script`.
- The harness types the probe prompt, polls `capture-pane -p` every 100 ms for the dialog text, sends keystrokes, and timestamps every event with a monotonic millisecond clock. The exact dialog text is recorded in P0, not assumed.
- Probe prompt: ask Claude to run `touch probe.txt` in the scratch dir. The `ask` rule `Bash(touch *)` forces the dialog. ALWAYS answer No/deny: the command never runs, and "don't ask again" is never chosen (it writes to `.claude/settings.local.json`).
- Stub hook = a small Node script launched exactly as SPEC section 9 does (`exec` form) so the process tree matches the real design. It logs START, a HEARTBEAT every 100 ms, the name and time of any SIGTERM/SIGHUP/SIGINT it receives, and END. It sleeps for N seconds and exits 0 with EMPTY output. It never emits allow or deny, in any trial.
- A second wrapper variant, plain `sh -c 'node stub.js; exit 0'`, to reproduce the orphaned-child case the adversarial review raised.
- Process-tree snapshots (`ps -o pid,ppid,pgid,command`) at START, at +5 s, right after the terminal answer, and 2 s after it.
- `--debug-file` captures the documented `Hooks: ... finished / timed out / cancelled` lines.

## Steps

- **P0 probe (3 to 5 sessions).** Hook logs only, no sleep. Proves: isolation (only our hook fires), the dialog appears, the exact dialog text, the debug-log format, tokens used per session, wall time per session. STOP here and report before anything else.
- **P1 terminal-answer case (10 trials).** Hook sleeps 60 s, `timeout` 90. When the dialog is seen, wait 4 s, answer No. Measure: dialog visible during the sleep (yes/no), time from the keystroke to Claude proceeding, whether and how fast the hook process dies (signal name, tree before and after, socket-equivalent: its heartbeat stops).
- **P2 timeout case (10 trials).** Hook sleeps 60 s, `timeout` 10, nobody answers for 20 s. Measure: when the dialog appears (immediately, or only after the hook is cancelled at 10 s), the kill signal and whether the whole tree dies, then answer No to finish.
- **P3 late-return case (5 trials).** Hook sleeps 8 s, `timeout` 30; answer No at 3 s. Measure: any effect when the hook exits late, any stray process.
- **P4 wrapper comparison (10 trials).** Repeat P1 with the plain `sh -c` wrapper. Measure: is node orphaned and does its heartbeat continue after Claude Code gives up.
- Stop early if any trial shows an implicit allow, a leaked foreign hook, a change to the hashed files, or a command actually running.

## Outcomes and what each changes in the design

| Result | Consequence |
|---|---|
| Dialog visible during the hook sleep, terminal answer proceeds within 1 s | Wait values stay 25/28/30 s (OQ8); approve is viable |
| Dialog blocked until the hook returns or times out | Waits drop to 10 s or less and slice 2 comes back to the owner for a new decision |
| Hook killed (whole tree) within 2 s in 10 of 10 | The socket closing is a usable cancel signal |
| Not killed, or only the shell dies | R74 (parent poll plus heartbeat) is the only cancel signal; ORPHANED detection takes up to 6 s; the `exec` form becomes mandatory |
| Results differ between trials | Treated as failure of that criterion; the design assumes the worst case |

## Limits and cost

- Hard cap: 35 sessions in total, `--model haiku`, one prompt each, `/exit` after the observation. P0 measures real tokens and seconds per session first; the full matrix only starts after the owner has seen that number.
- No session touches a real project: scratch directory only, deleted afterwards (the trust entry in `~/.claude.json` is the one residue, see above).
- Results are recorded as numbers and timings only (no transcript content) in `docs/v0.2/spikes/S1.md`, and the spec rows for A5, A6 and S1 are updated from them.

## Needs the owner's approval before P0

1. Run real `claude` sessions and the private tmux with the sandbox switched off (they need network and a pty).
2. The trust-entry side effect on `~/.claude.json` (option 1, 2 or 3 above).
3. Stop after P0 for a go/no-go before the 35-session matrix.
