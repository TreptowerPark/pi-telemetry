# pi-telemetry

A Pi extension that adds a compact TUI dashboard for context usage, Codex quotas, and prompt-cache timing.

## Features

- **Context Telemetry** — context-window percentage, token counts, per-turn and total cost, output-token velocity, message count, and stream duration.
- **Codex Limits** — five-hour and weekly Codex quota windows, remaining-use bars, and reset countdowns. Limits are read from the local Codex app server and refreshed periodically. Sliding placeholder reset timestamps for unused windows are suppressed.
- **Cache Timer** — a 30-minute cache-guarantee countdown for eligible `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra` requests, plus cache hit/miss and read/write token telemetry.
- **Responsive layout** — the panels render side-by-side when space allows and stack cleanly in narrower terminals.

The widget is UI-only: telemetry is not written into the model context or session history.

## Install

Install directly as a Pi package:

```bash
pi install git:github.com/TreptowerPark/pi-telemetry
```

To try it without adding it to settings:

```bash
pi -e git:github.com/TreptowerPark/pi-telemetry
```

## Requirements

- Pi `0.85+` (the extension imports Pi's `@earendil-works/*` packages).
- A terminal running Pi's interactive TUI.
- The `codex` CLI on `PATH` for Codex quota reporting. Set `PI_CODEX_BIN` if it is installed elsewhere.
- An authenticated `openai-codex` provider in Pi. If Codex quota data cannot be verified against the active Pi account, the limits panel shows `unavailable`.

## Local development

From a checkout, load the extension for one Pi run:

```bash
pi -e ./telemetry.ts
```

The extension has no build step; Pi loads the TypeScript source directly.

Run the focused quota-window tests with:

```bash
npm test
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CODEX_BIN` | Override the Codex executable used for quota requests. |

Codex quota refreshes occur every 90 seconds and also react to Codex rate-limit update notifications. The cache countdown redraws once per second while the TUI is active.

## License

MIT
