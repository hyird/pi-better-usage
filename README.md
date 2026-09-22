# pi-better-usage

[pi](https://pi.dev) 的订阅用量扩展，只查询剩余额度与重置时间。

基于 [pi-better-opencode-go](https://github.com/hyird/pi-better-usage) 扩展，参考
[pi-better-openai](https://github.com/monotykamary/pi-better-openai) 和
[pi-better-grok](https://github.com/monotykamary/pi-better-grok) 的认证与用量接口。

## 支持范围

| 服务             | Pi provider                    | 查询内容                                        |
| ---------------- | ------------------------------ | ----------------------------------------------- |
| OpenAI Codex     | `openai-codex`                 | 5 小时、每周额度；支持单周窗口和 Spark 独立额度 |
| Grok / SuperGrok | `xai`、`xai-oauth`、`xai-auth` | 统一订阅账期剩余额度；兼容旧版月度 credits      |
| OpenCode Go      | `opencode-go`                  | 5 小时、每周、每月额度                          |

这里的 OpenAI 指 Codex 订阅，OpenCode 指 Go 订阅。OpenAI / xAI API 账单、OpenCode Zen 按量余额不属于本扩展范围。

## 安装

```bash
pi install git:github.com/hyird/pi-better-usage
```

本地开发安装：

```bash
pi install F:/Workspace/windows/pi-better-usage
```

在 Pi 内执行 `/reload`。如果已安装旧版 `pi-better-opencode-go`，先用
`pi remove git:github.com/hyird/pi-better-opencode-go` 移除旧登记，避免重复加载。
若同时使用 better-openai / better-grok，请关闭它们的用量显示，避免重复页脚。

## 命令

只注册一个命令：`/usage`。每次执行都会并行重新查询 OpenAI、Grok、OpenCode 三家订阅，显示剩余百分比和重置时间；未登录或查询失败的服务显示具体提示，不影响其他结果。

每个额度窗口显示 20 格进度条，实心 `█` 表示剩余额度，空心 `░` 表示已用额度（每格约 5%，旁边的数字为实际百分比）。在终端中按剩余比例显示绿色、黄色或红色。

```text
OpenAI Codex usage
5h rolling: [███████████████░░░░░]  75% left ·  25% used
  Resets: 9/22 23:33 · in 2h3m
week:       [████████████░░░░░░░░]  60% left ·  40% used
  Resets: 9/27 21:30 · in 5d0h
Captured: 9/22 21:30
```

进度条样式参考 [pi-usage](https://github.com/TianZuo555/pi-extensions/tree/main/packages/pi-usage)，仅借鉴展示方式。

默认在编辑器下方显示当前 provider 的用量，每 60 秒刷新；其他服务只在命令查询时访问。

```text
Usage: 5h 75% left · wk 60% left · ↺ 2h3m - 9/22 14:03 · work
```

以上为示例数据。三家服务的重置时间和查询时间统一使用本地时区的 `M/D HH:mm`（24 小时制）。仅多账号登录时显示真实账号标签，不显示 `pi`、`auth.json` 等凭据来源。剩余 ≤30% 为黄色，≤10% 为红色。重置倒计时对应最接近额度上限的窗口。
未知窗口不会显示为 100% 剩余；请求失败会清除页脚，用命令查看错误。

## 认证与多账号

- **OpenAI**：先 `/login openai-codex`。优先使用 pi-multiprovider 当前账号，再由 Pi 解析/刷新 OAuth；最后读取 Pi auth.json 中未过期的 OAuth。账号 ID 来自该 token 或同一条存储记录。
- **Grok**：先 `/login xai`（或相应 OAuth provider）。同样优先使用 pi-multiprovider 与 Pi OAuth；还可复用 `grok login` 写入的 `~/.grok/auth.json`。自定义路径使用 `PI_GROK_AUTH_PATH`。普通 xAI API key 不能用于订阅查询。
- **OpenCode Go**：优先 pi-multiprovider、Pi provider registry、Pi auth.json；最后使用 `OPENCODE_API_KEY`。

支持 `/multilogin` 和账号切换通知。模型、账号或会话变化会撤销旧请求并清除旧数据，避免显示上一账号的额度。池认证失败不会退回其他账号。
认证失效时重新登录；扩展不自行重写认证文件。凭据不写入缓存、日志或通知。

## 配置

全局：`$PI_CODING_AGENT_DIR/extensions/pi-better-usage.json`，默认
`~/.pi/agent/extensions/pi-better-usage.json`。
项目覆盖：`<project>/.pi/extensions/pi-better-usage.json`。
从旧版升级时，将 `opencode-go-usage.json` 改名为 `pi-better-usage.json` 即可沿用设置。

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

- `footerMode`：`widget` 为彩色编辑器下方用量，`status` 为 Pi 页脚文本，`off` 隐藏。
- `enabled: false` 关闭自动刷新与显示；手动命令仍可查询。
- `refreshIntervalMs` 限制在 15 秒至 1 小时。
- `windows` 同时过滤页脚与详情；未知 Grok 账期映射为 rolling，但显示标签为 period。
- 兼容 better-grok 的 `footer.mode`：`status` 映射到 widget，`replace` 映射到 status。

## 接口与限制

- OpenAI：`GET https://chatgpt.com/backend-api/wham/usage`，Bearer OAuth + `chatgpt-account-id`。
- Grok：先 `GET https://cli-chat-proxy.grok.com/v1/user` 验证身份，再请求
  `GET /v1/billing?format=credits`，携带 `X-XAI-Token-Auth` 与 `x-userid`。
- OpenCode Go：`GET https://opencode.ai/zen/go/v1/usage`，Bearer key。

OpenAI / Grok 使用与参考扩展一致的非公开接口，服务端变更可能导致查询失败。
不提供购买、重置额度、fast mode、宠物、图片生成等功能。
不自动发送模型请求；所有网络访问仅用于身份与用量读取。

## 开发与验证

```bash
bun install --frozen-lockfile
bun run check
```

测试包含响应解析、请求认证、账号隔离、失效处理、模型切换、延迟响应以及三家集成。
HTTP 测试使用固定样例，不代表真实账号已联网验证。测试固定 UTC；实际显示使用本地时区，格式固定为 `M/D HH:mm`。

MIT，见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
