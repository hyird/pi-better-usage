# Third-party notices

This extension talks to OpenCode's own usage endpoint. It compiles no third-party protocol
implementation, but two MIT-licensed projects in the pi ecosystem shaped its design:

- **pi-better-grok** (github.com/monotykamary/pi-better-grok) — the footer reading this extension
  mirrors: the `Usage: …% left · ↺ <countdown> - <clock>` line, the green/amber/red severity
  thresholds (30% / 10% left), the dim trailing suffix, and the `footer.mode` vocabulary
  (`status` / `replace` / `off`). MIT License. Copyright (c) monotykamary.
- **pi-better-openai** (github.com/monotykamary/pi-better-openai) — the earlier extension that
  established the same footer conventions. MIT License. Copyright (c) monotykamary.
- **pi-multiprovider** (github.com/monotykamary/pi-multiprovider) — the `pi-multiprovider:service`
  announcement contract this extension listens to for pooled accounts. MIT License. Copyright (c)
  monotykamary.

All trademarks belong to their respective owners. This project is not affiliated with or endorsed
by OpenCode, xAI, or the authors of the projects listed above.
