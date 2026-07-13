# pi-openai-usage

A standalone [Pi](https://pi.dev) extension that shows ChatGPT Codex rate-limit usage in Pi's footer and with `/usage`.

## Important: private endpoint

This extension calls `https://chatgpt.com/backend-api/wham/usage`. This is an undocumented, private ChatGPT endpoint, not a supported OpenAI API. It may change, become unavailable, or be subject to account restrictions without notice. Use it only if you accept that risk; OpenAI's own UI and documentation remain authoritative.

## Features

- Places compact usage on the right side of the working-directory/branch line, for example: `5h 73% · 7d 90%` or `7d 98%` when OpenAI returns only one window.
- Preserves Pi's token/context/model line and the separate extension-status line below it.
- Keeps reset countdowns and local reset times in `/usage` instead of adding another TUI line.
- Matches the Codex app by showing percentage remaining (`100 − used_percent`).
- `/usage` force-refreshes and displays all available windows, remaining percentages, relative and local reset times, and update time.
- Refreshes without blocking Pi at session start, when an `openai-codex` model is selected, and after the agent settles.
- Background refreshes are throttled to at most once a minute; there is no periodic timer.
- Uses only Pi's public extension APIs. It verifies Pi's built-in Codex model is using OAuth, then obtains a refreshed access token with `ctx.modelRegistry.getApiKeyForProvider("openai-codex")`.
- Decodes the ChatGPT account ID claim locally and sends it only as the required request header.
- Clears its footer when Codex OAuth is unavailable or a refresh cannot produce valid data.

## Installation

Install a pinned release:

```bash
pi install git:github.com/jonathan-teamstatus/pi-openai-usage@v0.1.3
```

For local development:

```bash
pi install "$PWD"
```

Select a built-in `openai-codex` model and sign in through Pi's `/login`. The compact usage text appears only after a successful response.

## Footer compatibility

Pi's public `setStatus` API cannot right-align text within the working-directory line, so this extension uses the public custom-footer API and mirrors Pi 0.80.x's standard three-line footer. Pi supports one custom footer at a time; another custom-footer extension loaded later will replace this one. The mirrored footer keeps the normal `(auto)` indicator but cannot observe a runtime auto-compaction toggle, and it omits Pi's experimental `xp` marker.

## Command

| Command | Behavior |
| --- | --- |
| `/usage` | Force-refresh usage and show detailed, multiline status. |

## Privacy and security

- OAuth access tokens and decoded account IDs are held only in memory for a request. They are never written to disk, session state, the usage display, notifications, or logs.
- The extension does not persist usage data or start a timer.
- It deliberately does not include endpoint response bodies in errors. `/usage` reports a generic sign-in/refresh failure instead.
- The request has a 10-second timeout, rejects redirects, and sends `Authorization: Bearer <token>` plus `ChatGPT-Account-Id` only to the fixed `chatgpt.com` endpoint.

See [SECURITY.md](SECURITY.md) for reporting and trust-boundary details.

## Development

```bash
npm install
npm run verify
```

`verify` typechecks, runs tests, and performs `npm pack --dry-run`.

## License

MIT
