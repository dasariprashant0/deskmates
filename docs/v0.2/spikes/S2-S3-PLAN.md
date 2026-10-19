# Spikes S2 and S3 plan: hook failure modes, and our hook versus a second hook

Status: plan only. Nothing here has been run. Every step that starts a real `claude` session needs the owner's yes first. S1 (`S1.md`) passed on 2026-10-19 and its harness is reused.

## Why these two

- **S2** (SPEC section 15): after the hook exits 1, exits 2, prints invalid output, is killed by a signal, ignores SIGTERM or times out, does the normal dialog still appear and is nothing allowed or denied implicitly? Pass criterion from the spec: in every case the dialog appears and nothing is decided implicitly. Any implicit allow or deny stops v0.2 at slice 1.
- **S3**: our hook returns none, allow or deny while a second hook returns none, allow or deny (3 by 3). Pass criterion: a defined, repeatable result in all nine cells and a deny from either side is never overridden by our allow. A failure means control ships OFF regardless of what `doctor` can discover.

## Already known (so these spikes need not repeat it)

- Empty output with exit 0 is logged as plain text, treated as no decision, and the dialog waits (S1, P0).
- A hook cancelled at its `timeout` gets SIGTERM and the dialog is then answerable (S1, P2). That is the "times out" case of S2: done.
- A terminal answer cancels the hook with SIGTERM (S1, P1).
- Docs (not yet measured): exit 2 is not honored for PermissionRequest; other non-zero is a non-blocking error unless `onFailure: block`; how multiple hooks combine is not stated.

## Harness changes (scratch dir only, S1 harness reused)

1. **`hook2.js`** (replaces the stub): one script whose behaviour comes from environment variables set in the settings command (`MODE`, `DELAY_MS`, `EXIT_CODE`, `TEXT`). It logs BOOT, a heartbeat every 250 ms, START, any SIGNAL, END, as before. Modes: `exit` (exit with a code, no output), `text` (print a string), `json` (print a decision object), `selfkill` (SIGKILL itself), `ignoreterm` (ignore SIGTERM, keep running), `hang` (never exit).
2. **`mksettings4.sh`**: can write TWO hook entries: ours through `--settings`, and a second ("foreign") entry in the scratch folder's `.claude/settings.local.json`, so the two live in different scopes the way a user's own hook and ours would. Never touches `~/.claude`.
3. **`harness4.py`**: S1's harness plus an outcome classifier read from the debug log and the scratch folder, with no screen reading:
   - `dialog`: no decision before the probe key press; after Esc the log shows `Bash tool permission denied` within 1 s (the dialog was live);
   - `denied_implicit`: the denial appears without any key press;
   - `executed`: `probe.txt` appears (an allow took effect);
   - `other`: anything else, recorded with the relevant log lines.
   Esc remains the only key sent at a permission dialog; sessions end with Ctrl+C then SIGTERM.
4. Each trial writes one numbers-only line to `results-s2s3.jsonl` and its logs into a per-trial subfolder.

## S2 matrix (3 trials per row = 36 sessions)

| # | Hook behaviour | Docs say | Pass |
|---|---|---|---|
| 1 | exit 1, no output | non-blocking error | `dialog` |
| 2 | exit 2, no output, message on stderr | not honored for PermissionRequest | `dialog` |
| 3 | exit 0, truncated JSON (`{"hookSpecificOutput":`) | not stated | `dialog` |
| 4a | exit 0, plain text `allow` | not stated | `dialog` |
| 4b | exit 0, plain text `yes` | not stated | `dialog` |
| 5a | exit 0, valid JSON with an unknown behaviour value | not stated | `dialog` |
| 5b | exit 0, valid JSON with the wrong event name | not stated | `dialog` |
| 6 | killed by SIGKILL (hook kills itself) | crash is a non-blocking error | `dialog` |
| 7 | hook ignores SIGTERM, terminal answer at +4 s | not stated | the session proceeds at once; measure how long the hook stays alive (does Claude Code escalate to SIGKILL, when?) |
| 8 | hook hangs and ignores SIGTERM, `timeout: 10` | cancelled on timeout | `dialog` after the timeout; measure whether the hook is ever force-killed |
| 9a | valid ALLOW JSON, then exit 1 | not stated | `dialog` (a decision must not survive a failing exit) |
| 9b | valid ALLOW JSON, then killed by signal | not stated | `dialog` |

Rows 9a and 9b are the security-relevant ones (an implicit allow after a crash) and need the allow approval below. Rows 1 to 8 never allow anything; row 7 and 8 leave a stub process alive on purpose, killed by the harness at the end of each trial.

## S3 matrix (65 sessions)

- **Natural race, 9 cells by 5 runs = 45 sessions.** Ours in `--settings` returns none, allow or deny; the foreign hook in `.claude/settings.local.json` returns none, allow or deny; both answer immediately. Classify each run as `dialog`, `denied_implicit` or `executed`.
- **Forced order, 20 sessions.** For the two cells where the hooks disagree (ours allow with foreign deny, and ours deny with foreign allow): the foreign hook answers 400 ms first, and ours answers 400 ms first, 5 runs each. This shows whether the result depends on which hook finishes first.
- Pass: every cell gives the same result in all runs, and when either side denies the outcome is never `executed`. If the result depends on order, the finding is that control stays OFF unless deny always wins, and the spec says so.

## Safety rules and the deviation that needs approval

- Same as S1: scratch folder, `--setting-sources project,local --settings`, `--permission-mode default`, model haiku, Esc only at a dialog, Ctrl+C then SIGTERM to end, hash of `~/.claude/settings.json` before and after, abort on any hook line other than the stubs.
- **Deviation:** S3 and rows 9a/9b require a stub hook that RETURNS allow, so `touch probe.txt` will really run inside the scratch folder in those trials. It creates one empty file. The abort rule changes from "probe.txt appears" to "any file other than `probe.txt` changes in the scratch folder"; `probe.txt` is set aside between trials. Everything else in S2 keeps the original rule (`probe.txt` appearing is an implicit allow and stops the run).
- Stop immediately and report if S2 rows 1 to 8 ever show `executed` or `denied_implicit`: that is the spec's "stops v0.2 at slice 1" condition.

## Cost and time

Roughly 101 haiku sessions at 16 to 26 s each, about 30 minutes of wall time. S1 sessions cost $0.0009 to $0.0042 each, so the total should be well under $1 (not measured per trial in the matrix). Each session also writes a small synthetic transcript under `~/.claude/projects`; the earlier 40 are already there. The same scratch folder is reused, so no new trust entry is needed.

## Outcomes and what each changes

| Result | Consequence |
|---|---|
| S2 all `dialog` | R2 (exit 0, empty output on every failure path) stays as written; the fail-open design holds |
| S2 shows `executed` or `denied_implicit` in rows 1 to 8 | v0.2 stops at slice 1 (no decide), per the spec |
| 9a or 9b `executed` | The script must never print before the final answer and must never exit non-zero after printing (already R2); add a test that checks the order; consider the risk higher |
| Hook ignoring SIGTERM never dies | R74 (parent poll and self-exit) becomes mandatory for correctness, not defence in depth |
| S3 deterministic and deny always wins | A foreign hook is safe to coexist with; `doctor` still reports discovered ones |
| S3 order-dependent, or allow beats deny, or flaky | Control ships OFF regardless of `doctor` (spec S3) |

## What this will not show

One Claude Code version (2.1.302), macOS, the Bash tool, an interactive session in a Python pty; hooks of other types (http, prompt, agent); user-global and managed scopes for the foreign hook (only project-local plus `--settings` is exercised); real terminal emulators (S4, S17); the other tools.

## Needs the owner's approval before anything runs

1. Run about 101 real `claude` sessions (sandbox off, scratch folder only).
2. The allow deviation: stubs that return allow, so `touch probe.txt` runs in the scratch folder (S3 and rows 9a/9b).
3. Order: S2 rows 1 to 8 first (no allow), a stop for your review, then S3 and rows 9a/9b.
