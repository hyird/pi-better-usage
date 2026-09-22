# pi-better-usage

See how much subscription quota you have left without leaving [Pi](https://pi.dev).

One `/usage` command brings OpenAI Codex, Grok, and OpenCode Go together in a single report with aligned progress bars, remaining percentages, and reset times. A compact footer keeps the current provider's quota visible while you work. Switch models or providers and available cached usage appears immediately, with fresh data loaded in the background.

## Supported providers

| Service          | Pi provider                    | Subscription windows                                                                   |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| OpenAI Codex     | `openai-codex`                 | Five-hour and weekly limits, including weekly-only plans and separate Spark quota      |
| Grok / SuperGrok | `xai`, `xai-oauth`, `xai-auth` | Current subscription period, including unified weekly usage and legacy monthly credits |
| OpenCode Go      | `opencode-go`                  | Five-hour, weekly, and monthly limits                                                  |

The extension tracks subscription quota. OpenAI and xAI API spending, and OpenCode Zen pay-as-you-go balances, are outside its scope.

## Install

```bash
pi install git:github.com/hyird/pi-better-usage
```

Run `/reload` inside Pi, then `/usage`.

To update:

```bash
pi update git:github.com/hyird/pi-better-usage
```

Run `/reload` again to load the update.

## Usage

```text
/usage
```

Every invocation queries all three services in parallel. Each service shows its own result or a sign-in/error message, so one unavailable provider does not block the others.

Example output:

```text
OpenAI Codex usage
5h rolling: [███████████████░░░░░]  75% left ·  25% used
  Resets: 9/22 23:33 · in 2h3m
week:       [████████████░░░░░░░░]  60% left ·  40% used
  Resets: 9/27 21:30 · in 5d0h
Captured: 9/22 21:30

Grok usage
week:       [██████████████░░░░░░]  70% left ·  30% used
  Resets: 9/25 21:30 · in 3d0h
Captured: 9/22 21:30

OpenCode Go usage
5h rolling: [██████████████████░░]  90% left ·  10% used
  Resets: 9/22 23:00 · in 1h30m
week:       [████████████████░░░░]  80% left ·  20% used
  Resets: 9/26 21:30 · in 4d0h
month:      [█████████████░░░░░░░]  65% left ·  35% used
  Resets: 9/30 21:30 · in 8d0h
Captured: 9/22 21:30
```

Filled blocks represent **remaining** quota. Each block is approximately 5%; the number beside the bar gives the remaining percentage rounded to a whole number. In the terminal, bars are green above 30% remaining, yellow at 30% or below, and red at 10% or below.

All timestamps use your local time zone and the same compact 24-hour format: `M/D HH:mm`.

## Footer and refresh

The current provider's usage appears below the editor:

```text
Usage: 5h 75% left · wk 60% left · ↺ 5d0h - 9/27 21:30 · work
```

The account label appears only for a pooled account. The reset countdown belongs to the displayed window closest to its limit.

- The active provider refreshes every 60 seconds by default. Turn completion also checks whether the cache is due for an update.
- Model and provider switches show matching cached usage immediately, then refresh in the background. A provider without cached data needs its first query to finish.
- `/usage` always queries all providers again. Its report is a snapshot, not a live-updating panel.
- Account changes and new sessions clear the cache. Independent quota buckets, such as Spark, do not reuse the default bucket's reading.
- Failed queries hide the footer reading; `/usage` shows the error. Missing data is never presented as unused quota.

## Sign in

| Service      | Setup                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex | Run `/login openai-codex` in Pi.                                                                                          |
| Grok         | Run `/login xai` or sign in through the corresponding OAuth provider. An existing `grok login` session is also supported. |
| OpenCode Go  | Run `/login opencode-go`, or set `OPENCODE_API_KEY`.                                                                      |

OpenAI and Grok require subscription OAuth credentials; ordinary API keys cannot report their subscription quota.

When pi-multiprovider is installed, the extension uses the active or pinned account and responds to account-switch notifications. Otherwise, it uses Pi's credential resolver and stored credentials. Grok can also read `~/.grok/auth.json`; set `PI_GROK_AUTH_PATH` to use a different location.

Credentials are never written to disk by this extension or included in reports. If authentication expires, sign in again.

## Configuration

Global configuration: `~/.pi/agent/extensions/pi-better-usage.json`, or `$PI_CODING_AGENT_DIR/extensions/pi-better-usage.json` when that variable is set.

Project overrides: `<project>/.pi/extensions/pi-better-usage.json`.

```json
{
  "usage": {
    "enabled": true,
    "refreshIntervalMs": 60000,
    "windows": ["rolling", "weekly", "monthly"],
    "showAccountLabel": true
  },
  "footerMode": "widget"
}
```

| Setting                   | Behavior                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `usage.enabled`           | Enables automatic refresh and display. `/usage` still works when disabled.                                              |
| `usage.refreshIntervalMs` | Refresh interval, clamped to 15 seconds–1 hour.                                                                         |
| `usage.windows`           | Windows shown in both the footer and report. An unknown Grok period uses the `rolling` filter and displays as `period`. |
| `usage.showAccountLabel`  | Shows the active pooled account's label.                                                                                |
| `footerMode`              | `widget`: colored line below the editor; `status`: text in Pi's footer; `off`: hidden.                                  |

## Development

```bash
bun install --frozen-lockfile
bun run check
```

The checks cover TypeScript, lint, formatting, and tests for response parsing, authentication, account isolation, cached display, and request cancellation. HTTP tests use fixtures rather than live accounts.

OpenAI and Grok usage queries rely on private service endpoints, which may change. The extension only reads identity and usage data; it does not send model requests or modify subscription limits.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
