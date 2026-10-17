# Capability Map: deskmates

A local app that shows live Claude Code sessions as a pixel-art office. Draft for review; module ids are stable once approved.

| Module id | Responsibility | Depends on |
|---|---|---|
| core | Normalized event model, provider interface, shared types, ids | none |
| ingest-claude | Find, tail and parse Claude Code transcripts (including subagents) into core events | core |
| store | Live state reducer: sessions, agents, tool activity, tokens, cost, needs-you queue | core |
| server | Local HTTP and WebSocket server, per-launch token, snapshot plus delta protocol | store, ingest-claude |
| web | Canvas 2D office: procedural sprites, zones, animation, HUD | server (protocol only) |
| replay | Record events to disk and replay deterministically with a scrubber | core, store |
| control | Optional hooks (consent-gated install and uninstall), permission broker, approve or deny, jump to terminal | core, server |
| export | Shareable clip export of a replay, with redaction | replay, web |
| cli | `npx deskmates` entrypoint, flags, launch URL with token | server |

Build order: core -> ingest-claude and store (parallel) -> server and web (parallel) -> cli (first usable MVP) -> replay -> control -> export.

MVP (first usable) = core, ingest-claude, store, server, web, cli.

Rules
- Arrows point one way. No cycles.
- `web` talks to the rest only through the `server` protocol, so the renderer can later move into Electron, Tauri or a terminal UI unchanged.
- Other agent CLIs plug in as new `ingest-*` modules that emit `core` events.
- `control` is never required for the app to work and never installs anything without explicit consent.

Open for review
- Is `replay` before `control` the right order, or is approve and deny the bigger draw?
- Is `export` in scope for v1, or a v1.1 feature?
