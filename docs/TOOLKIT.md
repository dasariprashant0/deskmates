# deskmates toolkit: which skills, agents and plugins to use

Status: v0.1. Built from a scan of every installed skill (914 on disk), the 21 enabled plugins and the agent roster. deskmates is a standalone app, so only app-relevant tools are listed. Names are exact; if one stops resolving, say so instead of silently skipping it.

## Default loop for any task

1. `superpowers:brainstorming` (if the idea is fuzzy) or `spec-driven-development` -> `superpowers:writing-plans`.
2. Stress-test the plan: `mattpocock-skills:grilling` or agent `cto-toolkit:adversarial-reviewer`.
3. Build with `superpowers:subagent-driven-development` (fresh agent per task) or `superpowers:executing-plans`, using `test-driven-development` and `incremental-implementation`.
4. `verification-before-completion` (real output before saying done).
5. Review: agents `ecc:code-reviewer` and `ecc:typescript-reviewer`, plus `ecc:security-reviewer` for anything touching the server, hooks or transcripts.
6. `superpowers:finishing-a-development-branch`.

## Plugins worth keeping on for this project

| Plugin | Why |
|---|---|
| superpowers | planning, TDD, subagent-driven development, verification, branch finishing |
| security-guidance | pattern warnings on edits, LLM diff review on Stop, commit reviewer (injection, XSS, SSRF, hardcoded secrets). Directly covers risks 1, 5, 12 in `SECURITY.md` |
| agentic-council | 20 specialist agents and their skills: Architect, Skeptic, Tuner, Craftsman, Advocate, Guardian, Cipher, Chronicler, Operator |
| cto-toolkit | architecture-reviewer, security-auditor, release-readiness, tech-debt-analyzer, adversarial-reviewer agents |
| modern-web-guidance | current best practice for Canvas, WebSocket, browser APIs |
| design | design-critique, accessibility-review, design-system, design-handoff, ux-copy |
| engineering | architecture, code-review, deploy-checklist, testing-strategy, documentation |
| zizi-skills | tdd-skill, security-and-hardening, handoff, done, git-sync, plain-language |
| context-mode | keeps big transcripts and fetched docs out of the conversation |
| ECC (ecc) | the largest set: backend, testing, motion, cost, ADR, security, agents |
| agentic-harness | later: assess how well the project's agents and skills are used |
| figma | only if we mock screens in Figma before building |

## Plugins that are noise for this project (consider disabling to shorten the skill list)

searchfit-seo, linkedin-agent, marketing, sanity-plugin, cloudflare (unless we deploy a landing page there), ai-employees (hire), productivity, company-internal workflow plugins, product-management, cowork-plugin-management, and every language or domain skill that is not TypeScript or Node (AWS, Django, Laravel, Spring, Quarkus, Go, Rust, Kotlin, Swift, C++, Perl, healthcare, finance, logistics, homelab, network, DeFi, Vercel benchmark skills). Keep any employer or customer data out of this project entirely.

## Picks by module and phase

### Plan, spec, decisions
- Skills: `spec-driven-development`, `superpowers:writing-plans`, `planning-and-task-breakdown`, `idea-refine`, `ecc:plan`, `ecc:plan-prd`, `plan-canvas` (annotate plans in a browser), `documentation-and-adrs`, `ecc:architecture-decision-records`, `agentic-council:adr-template`, `agentic-council:technology-radar`, `agentic-council:library-evaluation` (dependency policy), `mattpocock-skills:domain-modeling` (event model), `mattpocock-skills:codebase-design`.
- Agents: `ecc:architect`, `ecc:code-architect`, `agentic-council:Architect`, `agentic-council:Strategist` (MVP scope), `Product Manager`, `cto-toolkit:adversarial-reviewer`, `ecc:planner`, `Plan`.

### core (event model, reducer) and store
- Skills: `ecc:hexagonal-architecture`, `ecc:contract-first`, `api-and-interface-design`, `ecc:error-handling`, `agentic-council:schema-design`, `agentic-council:distributed-patterns`, `ecc:cost-tracking` and `ecc:cost-aware-llm-pipeline` (pricing and cost derivation), `ai-regression-testing`.
- Agents: `ecc:type-design-analyzer` (event union design), `ecc:typescript-reviewer`, `ecc:tdd-guide`.

### ingest-claude (parser, watcher)
- Skills: `ecc:backend-patterns`, `ecc:error-handling`, `agentic-council:edge-case-enumeration`, `agentic-council:failure-mode-analysis`, `source-driven-development` (check Claude Code docs, do not guess), `update-config` and `git-guardrails-claude-code` (study how hooks are safely installed).
- Agents: `claude-code-guide` (transcript and hook behavior), `ecc:silent-failure-hunter` (swallowed parse errors), `ecc:performance-optimizer`, `agentic-council:Tuner`.
- Rule: inspect real transcripts for structure only, never content.

### server and control (hooks, approve/deny)
- Skills: `security-and-hardening`, `ecc:security-review`, `security-review`, `agentic-council:threat-model`, `agentic-council:data-classification`, `agentic-council:audit-trail-design`, `ecc:api-design`, `create-a-backend`, `backend-review`, `ecc:mcp-server-patterns` (only if we expose an MCP surface later).
- Agents: `ecc:security-reviewer`, `cto-toolkit:security-auditor`, `AI-Generated Code Security Auditor`, `agentic-council:Skeptic`, `agentic-council:Cipher` (token handling), `agentic-council:Guardian` (privacy).
- Plugin: security-guidance runs automatically.

### web (renderer, sprites, HUD)
- Skills: `frontend-ui-engineering`, `ecc:frontend-patterns`, `design-taste-frontend`, `frontend-design`, `ecc:frontend-design-direction`, `ecc:make-interfaces-feel-better`, `ecc:motion-foundations` and `ecc:motion-patterns` (motion tokens, reduced motion), `agentic-council:motion-design`, `agentic-council:interaction-design`, `ecc:accessibility`, `ecc:frontend-a11y`, `wcag-accessibility`, `antislop:antislop-ui`, `modern-web-guidance:modern-web-guidance`, `design:design-system`, `design:accessibility-review`.
- Agents: `UI Designer`, `Frontend Developer`, `Accessibility Auditor`, `ecc:a11y-architect`, `agentic-council:Artisan` (visual design), `agentic-council:Advocate` (UX), `Evidence Collector` (screenshot proof).
- Gap: no pixel-art, sprite or game-loop skill exists. We rely on `docs/DESIGN.md` and write the generator ourselves.

### Testing, performance, verification
- Skills: `test-driven-development`, `superpowers:test-driven-development`, `mattpocock-skills:tdd`, `ecc:e2e-testing`, `browser-testing-with-devtools`, `agentic-council:testing-strategy`, `agentic-council:e2e-testing`, `performance-optimization`, `ecc:benchmark`, `agentic-council:performance-audit`, `agentic-council:load-modeling`, `verification`, `ecc:verification-loop`, `ecc:test-coverage`.
- Agents: `ecc:e2e-runner` (Playwright), `ecc:pr-test-analyzer`, `ecc:performance-optimizer`, `Reality Checker`.

### Review and debugging
- Skills: `code-review-and-quality`, `code-review`, `simplify`, `ponytail:ponytail-review` (catches over-engineering), `superpowers:requesting-code-review`, `superpowers:receiving-code-review`, `superpowers:systematic-debugging`, `mattpocock-skills:diagnosing-bugs`, `debug`, `check`.
- Agents: `ecc:code-reviewer`, `superpowers:code-reviewer`, `ecc:comment-analyzer`, `ecc:refactor-cleaner`, `Minimal Change Engineer` (keeps bug-fix diffs small).

### Docs, demo and release
- Skills: `ecc:update-docs`, `agentic-council:documentation-plan`, `agentic-council:changelog-design`, `git-workflow-and-versioning`, `superpowers:using-git-worktrees`, `shipping-and-launch`, `ci-cd-and-automation`, `version-bump`, `ecc:github-ops`, `ecc:docker-patterns` (optional container), `agentic-council:deployment-plan`.
- README demo: `ecc:ui-demo` (Playwright screen recording), `slack-gif-creator`, `ffmpeg-skill`, `video-explainer`, `remotion-best-practices`.
- Agents: `ecc:doc-updater`, `agentic-council:Chronicler`, `cto-toolkit:release-readiness`, `cto-toolkit:tech-debt-analyzer`, `Developer Advocate`.
- Publishing (npm, GitHub) always needs the owner's explicit yes.

### Later phases
- Desktop wrapper: no Electron or Tauri skill exists; use `ecc:backend-patterns` plus `agentic-council:Pathfinder` for platform concerns.
- Team/LAN mode: `agentic-council:threat-model` again, `agentic-council:Cipher`, `agentic-council:Warden`.
- Other providers: `agentic-council:library-evaluation`, `ecc:agent-harness-construction`, `ecc:agent-eval`.

## Known friction in this environment

- The ECC GateGuard hook denies the first write of every new file and asks for facts. Add a `GATEGUARD_EXEMPT_GLOBS` entry for `~/Projects/personal/deskmates/**` to remove the friction, or accept one extra call per new file.
- Post-write quality hooks repeatedly flag single-test files. Add more tests where behavior is risky, otherwise ignore.
- Sandbox: reading `~/.claude/projects` and running the `claude` CLI need the sandbox lifted per command, and each use must stay task-relevant.
