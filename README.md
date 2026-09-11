# pi-telemetry

A Pi extension that adds a compact, model-aware TUI dashboard for context usage, Codex quotas, DeepSeek usage, and prompt caching.

## Features

- **Context Telemetry** — context-window percentage, token counts, per-turn and session cost, output-token velocity, message count, and stream duration.
- **Codex Limits** — five-hour and weekly Codex quota windows, remaining-use bars, and reset countdowns. Limits are read from the local Codex app server and refreshed periodically. Sliding placeholder reset timestamps for unused windows are suppressed.
- **OpenAI Cache Timer** — a 30-minute cache-guarantee countdown for eligible `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra` requests, plus cache hit/miss and read/write token telemetry.
- **DeepSeek Usage** — when Pi's direct `deepseek` provider is selected, Codex-specific panels are replaced with DeepSeek account balance, local turn/session spend, request/token totals, and peak/off-peak billing state.
- **DeepSeek Cache** — actual cache-hit and cache-miss tokens, per-request and session hit ratios, and estimated cache savings. DeepSeek has no fixed cache TTL, so no countdown is shown.
- **Responsive layout** — panels render side-by-side when space allows and stack cleanly in narrower terminals.

The widget is UI-only: telemetry is not written into the model context or session history. API keys are obtained through Pi's provider-auth API for requests that need them and are not printed or persisted by this extension.

## Model-aware layout

For `openai-codex`, the widget shows Context Telemetry + Codex Limits + OpenAI Cache. For Pi's direct `deepseek` provider, it shows Context Telemetry + DeepSeek Usage + DeepSeek Cache. Other providers receive the context panel only. Switching models updates the layout without restarting Pi.

DeepSeek balance comes from the documented `/user/balance` endpoint and refreshes every 90 seconds while a DeepSeek model is selected. Turn/session spend is calculated locally from Pi's normalized token usage because DeepSeek does not expose the platform Usage page's historical account aggregates through a documented public endpoint.

DeepSeek pricing follows the current peak/off-peak rate card. V4.1 Flash (`deepseek-flash`, including legacy V4 Flash aliases) uses the rates effective 2026-09-10. `deepseek-v4-pro` uses V4 Pro rates until DeepSeek's announced 2026-09-14 04:00 UTC routing cutover, after which the helper applies Flash rates. If DeepSeek changes pricing again, the local rate table must be updated.

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
- An authenticated `openai-codex` provider in Pi for Codex quota reporting.
- An authenticated direct `deepseek` provider in Pi for DeepSeek balance and DeepSeek-specific telemetry.

If provider data cannot be verified or fetched, the corresponding account panel shows `unavailable` without exposing credentials.

## Local development

From a checkout, load the extension for one Pi run:

```bash
pi -e ./telemetry.ts
```

The extension has no build step; Pi loads the TypeScript source directly.

Run the focused telemetry tests with:

```bash
npm test
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CODEX_BIN` | Override the Codex executable used for quota requests. |

Codex quota refreshes occur every 90 seconds and also react to Codex rate-limit update notifications. DeepSeek balance refreshes every 90 seconds while DeepSeek is active. The OpenAI cache countdown redraws once per second while the TUI is active.

## License

MIT
