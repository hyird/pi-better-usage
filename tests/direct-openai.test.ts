import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { resolveSubscriptionCredential } from "../src/subscription-auth.ts";
import { fetchOpenAIUsage } from "../src/providers.ts";
import { formatDetail, formatStatusLine } from "../src/usage.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { reportSavedAccounts } from "../src/account-report.ts";
import type { MultiproviderService, SavedUsageAccount } from "../src/multiprovider.ts";

const token = `header.${Buffer.from(
  JSON.stringify({
    aud: "https://api.openai.com/v1",
    scope: "openid email chatgpt.tokens.use.direct",
    "https://api.openai.com/auth": { encrypted_auth_metadata: "opaque" },
  }),
).toString("base64url")}.signature`;

describe("direct ChatGPT OAuth", () => {
  it.each(["registry", "file", "pool"])(
    "recognizes %s auth without a Codex account ID",
    async (source) => {
      const dir = mkdtempSync(join(tmpdir(), "direct-openai-"));
      try {
        writeFileSync(
          join(dir, "auth.json"),
          JSON.stringify({
            openai: {
              type: "oauth",
              access: token,
              expires: Date.now() + 3600000,
              email: "native@example.com",
            },
          }),
        );
        const ctx = {
          model: { provider: "openai" },
          modelRegistry: {
            isUsingOAuth: () => true,
            getProviderAuth: async () =>
              source === "registry" ? { auth: { apiKey: token } } : undefined,
          },
        } as unknown as ExtensionContext;
        const service =
          source === "pool"
            ? ({
                getActiveAccount: async () => ({ id: "pool", authKind: "oauth" }),
                resolveActiveAccountAuth: async () => ({
                  accessToken: token,
                  email: "native@example.com",
                  label: "work",
                }),
              } as unknown as MultiproviderService)
            : undefined;
        const credential = await resolveSubscriptionCredential("openai", ctx, {
          env: { PI_CODING_AGENT_DIR: dir },
          service: () => service,
        });
        expect(credential).toMatchObject({
          openaiAuthMode: "direct",
          providerId: "openai",
          email: "native@example.com",
        });
        expect(credential?.accountId).toBeUndefined();
        const fetchImpl = vi.fn();
        const snapshot = await fetchOpenAIUsage(credential!, { fetchImpl });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(snapshot.windows).toEqual({});
        const details = formatDetail(snapshot, DEFAULT_CONFIG, credential!);
        expect(details).toContain("Signed in with ChatGPT");
        expect(details).toContain("Settings → Usage");
        expect(details).not.toContain("100%");
        expect(formatStatusLine(snapshot, DEFAULT_CONFIG)).toContain("OAuth connected");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it("supports direct saved accounts without sending the token to the Codex backend", async () => {
    const accounts = [
      { id: "openai/work", providerId: "openai", label: "work", authKind: "oauth", active: true },
    ] as SavedUsageAccount[];
    const service = {
      resolveAccountAuth: async () => ({
        accessToken: token,
        label: "work",
        email: "native@example.com",
      }),
      listAccounts: async () => accounts,
    } as unknown as MultiproviderService;
    const fetchImpl = vi.fn();
    const report = await reportSavedAccounts(
      { model: { provider: "openai", id: "gpt-6.1-sol" } } as unknown as ExtensionContext,
      service,
      accounts,
      DEFAULT_CONFIG,
      { fetchImpl },
    );
    expect(report).toContain("native@example.com [Current]");
    expect(report).toContain("direct OAuth");
    expect(report).not.toContain("authentication or usage lookup failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
