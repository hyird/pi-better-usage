import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSubscriptionCredential } from "../src/subscription-auth.ts";
import type { MultiproviderService } from "../src/multiprovider.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const jwt = (account: string) =>
  `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
function setup(provider = "openai-codex", stored: unknown = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-auth-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(stored));
  const env = { PI_CODING_AGENT_DIR: dir, PI_GROK_AUTH_PATH: join(dir, "grok.json") };
  const ctx = {
    model: { provider },
    modelRegistry: { getProviderAuth: vi.fn().mockResolvedValue(undefined) },
  } as unknown as ExtensionContext;
  return { ctx, env };
}
describe("OAuth credential selection", () => {
  it("extracts the account ID from Pi's refreshed Codex token", async () => {
    const { ctx, env } = setup();
    vi.mocked(ctx.modelRegistry.getProviderAuth).mockResolvedValue({
      auth: { apiKey: jwt("new-account") },
    } as never);
    expect(await resolveSubscriptionCredential("openai", ctx, { env })).toMatchObject({
      accountId: "new-account",
      source: "pi",
    });
  });
  it("supports stored Codex account IDs and rejects API keys", async () => {
    const { ctx, env } = setup("openai-codex", {
      "openai-codex": { type: "oauth", access: "opaque-token", accountId: "stored-account" },
    });
    expect(await resolveSubscriptionCredential("openai", ctx, { env })).toMatchObject({
      accountId: "stored-account",
    });
    vi.mocked(ctx.modelRegistry.getProviderAuth).mockResolvedValue({
      auth: { apiKey: "sk-api-only" },
    } as never);
    writeFileSync(join(env.PI_CODING_AGENT_DIR, "auth.json"), "{}");
    expect(await resolveSubscriptionCredential("openai", ctx, { env })).toBeNull();
  });
  it("rejects expired stored OAuth", async () => {
    const { ctx, env } = setup("openai-codex", {
      "openai-codex": { type: "oauth", access: jwt("expired"), expires: 1 },
    });
    expect(await resolveSubscriptionCredential("openai", ctx, { env })).toBeNull();
  });
  it("does not mistake an xAI API key for a Grok subscription", async () => {
    const { ctx, env } = setup("xai", { xai: { type: "api_key", key: "xai-key" } });
    vi.mocked(ctx.modelRegistry.getProviderAuth).mockResolvedValue({
      auth: { apiKey: "xai-key" },
    } as never);
    expect(await resolveSubscriptionCredential("grok", ctx, { env })).toBeNull();
    expect(ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });
  it("does not borrow a different xAI alias's account", async () => {
    const { ctx, env } = setup("xai-oauth", { xai: { type: "oauth", access: "wrong-account" } });
    expect(await resolveSubscriptionCredential("grok", ctx, { env })).toBeNull();
  });
  it("uses scoped Grok CLI credentials and seconds-based expiry", async () => {
    const { ctx, env } = setup("xai");
    writeFileSync(
      env.PI_GROK_AUTH_PATH,
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: "cli-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );
    expect(await resolveSubscriptionCredential("grok", ctx, { env })).toMatchObject({
      apiKey: "cli-token",
      label: "Grok CLI",
    });
  });
  it("uses a pooled account ahead of Pi's own login", async () => {
    const { ctx, env } = setup();
    const service = {
      getActiveAccount: async () => ({ id: "pool", authKind: "oauth" }),
      resolveActiveAccountAuth: async () => ({ accessToken: jwt("pooled"), label: "work" }),
    } as unknown as MultiproviderService;
    expect(
      await resolveSubscriptionCredential("openai", ctx, { env, service: () => service }),
    ).toMatchObject({ accountId: "pooled", label: "work" });
    expect(ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
  });
  it("never falls back to a different account when a pool fails", async () => {
    const { ctx, env } = setup("openai-codex", {
      "openai-codex": { type: "oauth", access: jwt("wrong-account") },
    });
    const service = {
      getActiveAccount: async () => ({ id: "pool", authKind: "oauth" }),
      resolveActiveAccountAuth: async () => {
        throw new Error("secret");
      },
    } as unknown as MultiproviderService;
    await expect(
      resolveSubscriptionCredential("openai", ctx, { env, service: () => service }),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});
