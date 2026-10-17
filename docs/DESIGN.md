# deskmates UI and pixel-art design

Status: draft v0.1, from the UI Designer agent's spec.

## Canvas and scaling
- Logical resolution 320x180 per room view (16:9), 16 px tiles (20x11 grid plus a 4 px HUD strip). Rooms may pan; the camera snaps to whole pixels.
- Render to an offscreen canvas, blit with `imageSmoothingEnabled = false`. Scale = `floor(min(cssW*dpr/320, cssH*dpr/180))`, minimum 1, integer only, letterbox the rest. Backing store in device pixels; CSS size separate; `image-rendering: pixelated` as fallback.
- Under 640 px wide: compact view that follows the focused agent; HUD becomes a bottom sheet.
- 30 fps cap via `requestAnimationFrame`; pause when the tab is hidden.

## Palette (max 32 colors, shared by room and sprites)

| Token | Night | Cozy-light |
|---|---|---|
| bg | #1b1a2e | #f3e9d8 |
| floor | #2c2a46 | #d9c3a0 |
| wall | #3a3758 | #b98f6a |
| wood | #6b4a3a | #8a5a3c |
| light wood | #9a7b62 | #c9a27a |
| text | #f1ead8 | #2d2218 |
| text-dim | #a9a3c2 | #6b5a48 |
| accent | #ffb454 | #e08a1e |
| outline | #0d0c1a | #3b2a1e |

Status colors (Okabe-Ito, color-blind safe; every status also has a shape so color is never the only signal):
working #0072B2 (rotating dashes), thinking #CC79A7 (three pulsing dots), needs-you #E69F00 (thick ring plus bell), error #D55E00 (zigzag plus "!"), done #009E73 (check mark), idle #999999 (no ring). Verify 3:1 contrast against both floors and 4.5:1 for label text in CI.

## Procedural sprites (original art only)
- 16x24 px character from layered 1-bit template masks, drawn in code. Seed `cyrb53(agentName)` feeds mulberry32, so the same name always gives the same person.
- Slots: body (3 builds), skin ramp (8), hair style (10), hair ramp (10), outfit (6), outfit ramp (12), accessory (none, glasses, headphones, cap, scarf, mug, badge; two may stack), one quirk pixel (freckle, blush, beard).
- Each color is a 3-step ramp: shadow = L-18% hue toward blue; highlight = L+14% hue toward yellow.
- Draw order: shadow, legs, outfit, body, head, hair-back, face, hair-front, accessory. Cache each sheet on an offscreen canvas once (about 50 frames, under 5 ms).
- Directions: down, up, left; right mirrors left.
- Animations: walk 4 frames at 8 fps; idle 2; sit 1; type 2 at 6 fps; read 2; think 3; celebrate 4; error 3; sleep 2.
- A name-initial plate on the desk keeps look-alikes distinguishable.

## Office layout
Tool to zone: Read, Grep, Glob -> bookshelf; Bash -> terminal bench; Edit, Write, NotebookEdit -> whiteboard; WebSearch, WebFetch -> web wall; Agent -> door (child walks in and out); TodoWrite -> own desk sticky-note board; MCP tools -> patch-panel rack, one port per MCP server; thinking -> own desk with thought dots; waiting for permission -> bell zone; error -> red flash in place; done -> celebrate then coffee corner; idle -> coffee corner.

Scaling: one room per project (working directory), a fixed 20x11 layout with desks for 1-6 agents (subagents are guests). Default home is a command-center grid of half-scale mini rooms; click or Enter zooms in. Rooms with a Needs-you agent get a pulsing amber border and sort first. Over 12 rooms, idle rooms collapse into one strip. Over 6 agents in a room, extras use a standing hot-desk row.

## Animation and state machine
- States: spawn, walking, at-zone, thinking, waiting-permission, error, done, idle, leave. Zone chosen by tool name.
- Debounce: only walk if the tool will probably last over 1.5 s; otherwise play the work animation in place with a small tool-icon bubble. Minimum dwell 2 s to avoid ping-pong.
- Pathfinding: A* on the tile grid, 4-neighbor, per-room walkable mask, paths cached per zone pair.
- Conflicts: zones have N slots; agents reserve before walking; full zones mean queueing at a waiting tile with a "..." bubble; cooperative next-tile reservation; a deadlock over 1 s makes the lower-priority agent sidestep.
- Speech bubbles: one line, 24 characters max (for example "Read: auth.ts"), shown 3 s on change or while hovered. Names only, never file contents or prompts.

## HUD (real DOM, not canvas)
- Needs-you queue top-right: oldest first, avatar, project, raw command or question text (truncated), Jump button, amber badge; `N` jumps to the oldest.
- Agent card: name, task, current tool and target, status, tokens in and out, estimated cost, elapsed time, context-window bar, subagent list, last 5 events.
- Replay scrubber bottom: colored ticks per status, drag to rewind, space to play or pause, 1x/4x/16x; LIVE pill when attached.
- Settings: theme, sound and volume, reduced motion, scale lock, show cost, privacy (hide file names), room sort, name aliasing.

## Accessibility
- Reduced motion (follows `prefers-reduced-motion`, with override): agents teleport with a 150 ms fade, no walk cycle, static icons.
- Keyboard: Tab cycles rooms and agents in DOM order; arrows move between agents; Enter opens the card; `N` Needs-you; `Esc` overview; `?` shortcuts; 2 px accent focus outline.
- Screen reader: canvas is `aria-hidden`; a hidden DOM list mirrors every agent and state; `aria-live="polite"` announces changes, `assertive` for Needs-you.
- Sound off by default; bell, thud and chime cues with separate volume and optional visual flash; never the only signal.
- HUD targets at least 44 px; HUD text at least 14 px.

## Build phases
1. Charming MVP: one room, procedural sprites (walk, type, sit), Read/Bash/Edit/Web zones, status rings, event stream from local logs, agent card, DOM mirror, reduced motion.
2. Needs-you bell and queue, door and subagents, coffee corner, TodoWrite and MCP zones, bubbles, pathfinding and slot conflicts.
3. Multi-room command center, light theme, full animation set.
4. Replay scrubber, settings, sound, cost and tokens, polish, shortcuts.
5. Cosmetics, desk decor, shareable screenshots.

Skipped: art assets, WebGL, per-pixel lighting. Revisit only if Canvas 2D hits a measured ceiling.
