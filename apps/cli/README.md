# deskmates (CLI)

Starts a local server that reads your Claude Code session transcripts and shows them as a pixel office in your browser. Not published to npm yet; build and run from this repo.

## Build and run

    node build.mjs            # writes dist/deskmates.js (+ dist/client if packages/client/dist exists)
    node dist/deskmates.js [start] [flags]

## Flags

- `--port <n>`: port, integer 0-65535 (default 7878, 0 = random free port)
- `--no-open`: do not open a browser
- `--projects-dir <path>`: transcripts directory (default `~/.claude/projects`)
- `--help`, `--version`

Exit codes: 0 ok, 1 port busy or cannot listen, 2 usage error, 70 unexpected error, 130 second Ctrl+C.

## Privacy

`Local only: reading transcripts on this machine, nothing is sent anywhere.` The server binds 127.0.0.1 only.

A fresh random token is generated on every launch. It is never written to disk or logged; it appears only in the launch URL, inside the fragment (`http://127.0.0.1:PORT/#t=TOKEN`), which browsers never send to the server.

## Security note: the browser opener

Unless you pass `--no-open`, the CLI starts your OS opener (`open`, `xdg-open` or `cmd /c start`) with the full URL, fragment and token included, as a process argument. Other local processes of the same user can see process arguments for a moment. If that matters, use `--no-open` and paste the printed link into your browser yourself.
