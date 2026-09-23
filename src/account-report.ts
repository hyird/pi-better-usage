import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageConfig } from "./config.ts";
import { sanitizeLabel } from "./format.ts";
import type { MultiproviderService, SavedUsageAccount } from "./multiprovider.ts";
import { USAGE_PROVIDERS } from "./providers.ts";
import { formatDetail, UsageError, type FetchLike, type UsageSeverity } from "./usage.ts";

/** Read every profile in isolation. A failed account must never fall back to the current login. */
export async function reportSavedAccounts(
  ctx: ExtensionContext,
  service: MultiproviderService,
  accounts: SavedUsageAccount[],
  config: UsageConfig,
  options: {
    fetchImpl?: FetchLike;
    env?: NodeJS.ProcessEnv;
    now?: number;
    colorize?: (severity: UsageSeverity, text: string) => string;
    colorHeading?: (text: string) => string;
  } = {},
): Promise<string> {
  const results: string[] = Array.from({ length: accounts.length }, () => "");
  let next = 0;
  async function worker() {
    while (next < accounts.length) {
      const index = next++;
      const account = accounts[index]!;
      const label = sanitizeLabel(account.label) ?? "unnamed";
      const authKind =
        account.authKind === "oauth"
          ? "Subscription"
          : account.authKind === "api_key"
            ? "API key"
            : "Other";
      const title = `${label}${account.active ? " [Current]" : ""} · ${authKind}`;
      const provider = USAGE_PROVIDERS.find((p) => p.providerIds.includes(account.providerId));
      const serviceName = provider?.name ?? sanitizeLabel(account.providerId) ?? "Unknown provider";
      const errorHeading = `${serviceName} usage · ${title}`;
      if (!provider) {
        results[index] = `${errorHeading}\nUsage reporting is not supported for this provider.`;
        continue;
      }
      try {
        let authenticationFailed = false;
        const isolated: MultiproviderService = {
          getActiveAccount: async (id) => (id === account.providerId ? account : undefined),
          resolveActiveAccountAuth: async (id) => {
            if (id !== account.providerId) return undefined;
            let auth;
            try {
              auth = await service.resolveAccountAuth!(account.id, ctx);
            } catch {
              authenticationFailed = true;
              throw new Error("Account authentication failed");
            }
            if (!auth?.accessToken) throw new Error("Missing account authentication");
            return auth;
          },
          onActiveAccountChanged: () => () => {},
        };
        const scoped = Object.create(ctx, {
          model: { value: { ...ctx.model, provider: account.providerId }, enumerable: true },
        }) as ExtensionContext;
        const credential = await provider.resolve(scoped, {
          service: () => isolated,
          env: options.env,
        });
        if (authenticationFailed) throw new Error("Account authentication failed");
        if (!credential) {
          results[index] =
            `${errorHeading}\nSubscription usage is unavailable for this credential type.`;
          continue;
        }
        const snapshot = await provider.fetch(credential, {
          fetchImpl: options.fetchImpl,
          now: options.now,
          modelId: ctx.model?.provider === account.providerId ? ctx.model.id : undefined,
        });
        const details = formatDetail(
          snapshot,
          { ...config, showAccountLabel: false },
          credential,
          options.now,
          options.colorize,
        ).split("\n");
        const accountHeading = `${details.shift()} · ${title}`;
        results[index] =
          `${options.colorHeading?.(accountHeading) ?? accountHeading}\n${details.join("\n")}`;
      } catch (error) {
        const reason =
          error instanceof UsageError
            ? error.message
            : "Account authentication or usage lookup failed.";
        results[index] = `${errorHeading}\nUsage unavailable. ${reason}`;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, () => worker()));
  // A removed account can disappear while requests are in flight. Recheck once,
  // but keep the report usable if account storage is briefly locked.
  let currentIds: Set<string> | undefined;
  try {
    if (service.listAccounts)
      currentIds = new Set((await service.listAccounts()).map((account) => account.id));
  } catch {
    // The initial roster was valid; per-account errors remain visible.
  }
  const groups = new Map<string, string[]>();
  accounts.forEach((account, index) => {
    if (currentIds && !currentIds.has(account.id)) return;
    const providerName =
      USAGE_PROVIDERS.find((provider) => provider.providerIds.includes(account.providerId))?.name ??
      account.providerId;
    const group = groups.get(providerName) ?? [];
    if (results[index]) group.push(results[index]!);
    groups.set(providerName, group);
  });
  return Array.from(groups.values(), (reports) => reports.join("\n\n"))
    .filter(Boolean)
    .join("\n\n");
}
