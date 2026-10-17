# deskmates: instructions for Claude

A local app that shows live Claude Code sessions as a pixel-art office. Read `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DESIGN.md` and `docs/ROADMAP.md` before changing anything. Module ids are in `CAPABILITY-MAP.md`.

## Use skills and agents on purpose

Before planning, designing, implementing, reviewing or researching, name the skill or agent you will use and use it. The ranked picks per module are in `docs/TOOLKIT.md`; a shorter per-step table is in `docs/ROADMAP.md` ("Tooling guide"). If nothing fits, say so. Do not do everything yourself when a specialist agent exists, and run independent agents in parallel.

Minimum for any non-trivial change:
1. Spec or plan: `spec-driven-development` or `superpowers:writing-plans`.
2. Tests first: `test-driven-development`.
3. Review before done: `code-review-and-quality` plus `ecc:code-reviewer`; security-touching code also `ecc:security-reviewer`.
4. Verify with real output before claiming done (`verification-before-completion`).

## Boundaries

Always:
- Keep the dependency direction in `CAPABILITY-MAP.md`; `web` only talks to the server protocol.
- Keep the parser tolerant: never throw on a bad line.
- Render transcript text as text, never as HTML.

Ask first:
- Adding a dependency, changing the event schema, touching hook install or uninstall code.
- Publishing anything (npm, GitHub) or installing hooks on the user's machine.

Never:
- Add a state-changing endpoint without the per-run token plus Host and Origin checks.
- Log or store raw transcript content, or send it anywhere.
- Use third-party art or assets.
- Read private transcript content during development; inspect structure only.

## Commands (to be filled in at scaffold time)

Build, test, lint and dev commands go here once the workspace exists.
