# deskmates roadmap and build guide

Status: draft v0.1, awaiting owner review. Follows the spec-driven workflow: Specify -> Plan -> Tasks -> Implement, with a review gate between phases.

## Scope decision to confirm

The risk review says v1 should be passive watching plus a "Needs you" notification, and that replay, export, other agents and team mode are separate products. You chose approve/deny and replay as differentiators, so they stay, sequenced behind the security gates:

| Release | Contents | Gate to ship |
|---|---|---|
| v0.1 | core, ingest-claude, store, server, web (office, sprites, zones, subagents), cli; Needs-you via heuristic; tokens, cost, time | Parser fixtures green; 50-session benchmark; no network in CI |
| v0.2 | control: consented hooks install/uninstall, hook-based Needs-you, approve/deny, jump to terminal | Rebinding harness, Host/Origin/token tests, race tests, install/uninstall byte-identical |
| v0.3 | replay: recorder, deterministic player, scrubber | Determinism hash test |
| v0.4 | export: redacted `.dmrec` and WebM clip | Seeded-secret test finds zero leaks in frames and files |
| later | other providers, layout editor, terminal mode, desktop wrapper, team mode | Separate threat model |

## Tooling guide: which skills, agents and plugins to use at each step

Use these on purpose. If none fits, say so in the PR.

| Step | Skills | Agents | Plugins and tools |
|---|---|---|---|
| Specify a release | `spec-driven-development`, `superpowers:brainstorming`, `idea-refine` | `ecc:architect`, `Product Manager` | `agentic-council:council` for contested trade-offs |
| Plan and slice | `superpowers:writing-plans`, `planning-and-task-breakdown`, `ecc:plan` | `Plan`, `ecc:planner` | task list per phase in `tasks/` |
| Record decisions | `documentation-and-adrs`, `ecc:architecture-decision-records` | `cto-toolkit:adversarial-reviewer` to attack each ADR | write ADRs in `docs/adr/` in the order in `ARCHITECTURE.md` |
| Verify Claude Code behavior | `source-driven-development` | `claude-code-guide` | `ctx_fetch_and_index` for docs; inspect real transcripts structure-only |
| Implement a task | `incremental-implementation`, `test-driven-development`, `superpowers:subagent-driven-development` or `superpowers:executing-plans` | `ecc:tdd-guide`, `ecc:typescript-reviewer` | `context-mode` for large files |
| Parser and watcher | `ecc:backend-patterns`, `ecc:error-handling` | `ecc:silent-failure-hunter` (swallowed parse errors), `ecc:performance-optimizer` | fixtures from scrubbed real transcripts |
| Server and hooks | `security-and-hardening`, `ecc:security-review`, `agentic-council:skeptic-threat-model`, `ecc:api-design` | `ecc:security-reviewer`, `cto-toolkit:security-auditor`, `AI-Generated Code Security Auditor` | DNS-rebinding harness in CI |
| Canvas, sprites, HUD | `frontend-ui-engineering`, `design-taste-frontend`, `ecc:motion-foundations`, `ecc:make-interfaces-feel-better` | `UI Designer`, `Frontend Developer`, `Accessibility Auditor` | built-in browser preview, `browser-testing-with-devtools`, Playwright |
| Accessibility | `wcag-accessibility`, `ecc:frontend-a11y` | `Accessibility Auditor`, `ecc:a11y-architect` | contrast check in CI |
| Performance | `performance-optimization`, `agentic-council:tuner-load-modeling` | `ecc:performance-optimizer` | benchmark script: 50 sessions under 5% CPU and 150 MB |
| Debug | `superpowers:systematic-debugging`, `debugging-and-error-recovery` | `ecc:build-error-resolver` | |
| Review before merge | `code-review-and-quality`, `superpowers:requesting-code-review`, `simplify`, `verification-before-completion` | `ecc:code-reviewer`, `superpowers:code-reviewer`, `ecc:pr-test-analyzer`, `Reality Checker` | `code-review` skill with `--max-findings` |
| Release | `shipping-and-launch`, `git-workflow-and-versioning`, `ecc:release-readiness` equivalents | `cto-toolkit:release-readiness`, `ecc:doc-updater` | publishing needs the owner's explicit yes |
| Wrap up | `superpowers:finishing-a-development-branch` | | save a project memory |

## v0.1 phases and tasks (to be expanded by `superpowers:writing-plans` after this review)

1. **Scaffold**: pnpm workspace, TypeScript, Vitest, lint, CI (no network). Verify: `pnpm -r test` green.
2. **core**: event types, reducer, selectors, `prices.json`. Verify: reducer property tests.
3. **provider-claude**: `parseLine` with fixtures (truncated line, unknown type, orphan result, subagent meta, version drift). Verify: golden event arrays.
4. **watcher and store**: directory watch, byte offsets, partial-line buffer, cache, away state. Verify: chunked-append, truncate, delete tests; benchmark.
5. **server**: HTTP and WebSocket on 127.0.0.1, launch token, Host/Origin checks, snapshot plus delta. Verify: spoofed Host/Origin/token tests.
6. **sprites**: generator and atlas, same-seed hash test.
7. **web**: renderer, zones, state machine, A*, rings, agent card, DOM mirror, reduced motion. Verify: Playwright against a fixture-streaming fake server.
8. **cli**: `deskmates` start, URL with token, `--no-open`, `--port`. Verify: run against real transcripts, structure only.
9. **Review gates**: security review, performance benchmark, accessibility audit, code review.

## Rules

- Never install hooks or edit settings without a shown diff and explicit consent.
- Never publish (npm, GitHub) without the owner's explicit yes.
- No transcript content leaves the machine; no telemetry.
- No third-party art; all sprites are generated.
