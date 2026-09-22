# pi-better-opencode-go

Better OpenCode Go for [pi](https://pi.dev) — your OpenCode Go subscription windows in a coloured
widget below the editor, plus a `/go-usage` report.

The reading is styled after [pi-better-grok](https://github.com/monotykamary/pi-better-grok): what is
_left_ of each window is coloured green/amber/red, the reset clock comes from the window closest to
its limit, and the pooled account label trails the line as a dim suffix.

```text
Usage: 5h 96% left · wk 99% left · mo 99% left · ↺ 4h12m - 9:30 PM · zhong
```

Data comes from the official endpoint `GET https://opencode.ai/zen/go/v1/usage`, authenticated with
the provider's own API key — no scraping, no browser, no extra dependency.

## Install

```bash
pi install git:github.com/hyird/pi-better-opencode-go
```

## Commands

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `/go-usage`         | Re-reads, then prints used/left and the reset time for each window  |
| `/go-usage refresh` | Same report, without the "refresh forces an immediate request" hint |

## The reading

- One `Usage: ` line with a `% left` token per window — `5h`, `wk`, `mo` — in endpoint order. A
  window the endpoint did not report is skipped rather than shown as zero.
- Colour matches pi-better-grok's thresholds: **green** above 30% left, **amber** at 30% or below,
  **red** at 10% or below.
- The reset suffix is `↺ <countdown> - <clock>` (`↺ 4h12m - 9:30 PM`) and always describes the
  window closest to its limit, which is the one that will run out first.
- The pooled account label is the trailing `· zhong`, in the slot pi-better-grok uses for its banked
  reset count. It is flattened to one line and capped at 24 characters before it reaches the
  terminal.
- A window whose status is not `ok` gets an ` !status` marker, so a broken window cannot hide
  behind a healthy percentage.
- The line is truncated to the terminal width with a dim `...`.
- While the first request is in flight — or after a failure — the widget shows `Go ?` instead of a
  silent gap. `/go-usage` always carries the full error.

## Credentials

The API key is resolved per request, in this order:

1. **pi-multiprovider pool** — `resolveActiveAccountAuth("opencode-go", ctx)` for the session's
   active or pinned account.
2. **Pi's provider registry** — `ctx.modelRegistry.getProviderAuth("opencode-go")`, accepting both
   the `{ auth: { apiKey } }` and `{ apiKey }` / bearer `headers` shapes.
3. **`~/.pi/agent/auth.json`** — the stored `{ type: "api_key", key }` entry.
4. **`OPENCODE_API_KEY`**.

Nothing is cached to disk and no credential is ever logged, notified or rendered.

### pi-multiprovider

When [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider) pools `opencode-go`, the
session's active (or pinned) account wins over Pi's own credential, its label is shown on the line,
and switching accounts discards the previous account's reading instead of reusing its quota.

This is the part no registry-based reading can do: `getProviderAuth()` cannot see pooled accounts —
with a pool it resolves only the upstream credential — so a registry-only reading would silently
report another account's quota.

## Configuration

Optional JSON, global at `$PI_CODING_AGENT_DIR/extensions/opencode-go-usage.json` (usually
`~/.pi/agent/extensions/opencode-go-usage.json`) and overridden per project by
`<project>/.pi/extensions/opencode-go-usage.json`. Every field has a default and invalid values are
ignored, so a broken config never breaks the reading.

```json
{
  "enabled": true,
  "windows": ["rolling", "weekly", "monthly"],
  "refreshIntervalMs": 60000,
  "onlyOnOpencodeModel": true,
  "showAccountLabel": true,
  "footerMode": "widget"
}
```

| Key                   | Default    | Meaning                                                                              |
| --------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `enabled`             | `true`     | Master switch for display; `/go-usage` still queries on demand.                      |
| `windows`             | all three  | Which windows to show, re-ordered to endpoint order. An empty list hides the line.   |
| `refreshIntervalMs`   | `60000`    | Poll interval, clamped to 15s…1h. The cache is also refreshed after each agent turn. |
| `onlyOnOpencodeModel` | `true`     | Show the reading only while the selected model belongs to `opencode-go`.             |
| `showAccountLabel`    | `true`     | Append the active pooled account label.                                              |
| `footerMode`          | `"widget"` | Where the reading renders — see below.                                               |

| `footerMode`         | Where the reading renders                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `widget` _(default)_ | Coloured line in the widget area below the editor — the same place pi-better-grok renders. |
| `status`             | Plain text in Pi's own footer, next to the other extension statuses.                       |
| `off`                | Hidden. `/go-usage` still works.                                                           |

pi-better-grok's own config shape is accepted too: `{"footer": {"mode": "status"}}` maps to `widget`
so a copied grok config looks identical, and grok's `replace` — a whole custom footer this extension
does not own — degrades to `status`.

## Development

```bash
bun install
bun run check   # typecheck, lint, format check, tests
bun run test    # vitest only
```

Tests pin `TZ=UTC` (see `vitest.config.ts`) because reset times render through the local time zone.

## Security

The endpoint is OpenCode's official usage surface and the request carries only the API key as a
bearer token. This extension never stores, prints or notifies a credential, and it masks nothing it
does not have to show: the account label is whatever pi-multiprovider announces.

## Acknowledgments

- [pi-better-grok](https://github.com/monotykamary/pi-better-grok) / [pi-better-openai](https://github.com/monotykamary/pi-better-openai)
  — the footer reading this extension mirrors, including the severity thresholds and `footer.mode`
  vocabulary.
- [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider) — the `pi-multiprovider:service`
  announcement contract used for pooled accounts.

## License

MIT — see [LICENSE](LICENSE).
