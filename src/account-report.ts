import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { awaitWithAbort } from "./abort.ts";
import type { UsageConfig } from "./config.ts";
import { sanitizeLabel } from "./format.ts";
import { accountEmail } from "./account-identity.ts";
import type { MultiproviderService, SavedUsageAccount } from "./multiprovider.ts";
import { USAGE_PROVIDERS } from "./providers.ts";
import type { UsageQueryCache } from "./query-cache.ts";
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
    signal?: AbortSignal;
    queries?: UsageQueryCache;
    onVerifiedRoster?: (accounts: SavedUsageAccount[], projected: SavedUsageAccount[]) => void;
  } = {},
): Promise<string> {
  const results: string[] = Array.from({ length: accounts.length }, () => "");
  const expectedRevisions = accounts.map((account) => account.credentialRevision);
  const emailUpdates: Array<{
    index: number;
    email: string;
    accessToken: string;
    updateEmail?: (email: string) => Promise<void>;
  }> = [];
  let hadLookupFailure = false;
  let next = 0;
  async function worker() {
    while (next < accounts.length) {
      options.signal?.throwIfAborted();
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
        let updateEmail: ((email: string) => Promise<void>) | undefined;
        const isolated: MultiproviderService = {
          getActiveAccount: async (id) => (id === account.providerId ? account : undefined),
          resolveActiveAccountAuth: async (id, _ctx, signal) => {
            if (id !== account.providerId) return undefined;
            let auth;
            try {
              signal?.throwIfAborted();
              auth = await service.resolveAccountAuth!(account.id, ctx, signal);
              signal?.throwIfAborted();
            } catch {
              authenticationFailed = true;
              throw new Error("Account authentication failed");
            }
            if (!auth?.accessToken) throw new Error("Missing account authentication");
            if (auth.credentialRevision) expectedRevisions[index] = auth.credentialRevision;
            updateEmail = auth.updateEmail;
            return auth;
          },
          onActiveAccountChanged: () => () => {},
        };
        const scoped = Object.create(ctx, {
          model: { value: { ...ctx.model, provider: account.providerId }, enumerable: true },
        }) as ExtensionContext;
        const credential = await provider.resolve(
          scoped,
          {
            service: () => isolated,
            env: options.env,
          },
          options.signal,
        );
        options.signal?.throwIfAborted();
        if (authenticationFailed) throw new Error("Account authentication failed");
        if (!credential) {
          results[index] =
            `${errorHeading}\nSubscription usage is unavailable for this credential type.`;
          continue;
        }
        const modelId = ctx.model?.provider === account.providerId ? ctx.model.id : undefined;
        const snapshot = options.queries
          ? (
              await options.queries.read(provider, credential, {
                providerId: account.providerId,
                modelId,
                signal: options.signal,
                ttl: config.refreshIntervalMs,
              })
            ).snapshot
          : await provider.fetch(credential, {
              fetchImpl: options.fetchImpl,
              now: options.now,
              modelId,
              signal: options.signal,
            });
        options.signal?.throwIfAborted();
        const details = formatDetail(
          snapshot,
          { ...config, showAccountLabel: false },
          credential,
          options.now,
          options.colorize,
        ).split("\n");
        const email =
          accountEmail(snapshot.accountEmail) ??
          accountEmail(credential.email) ??
          accountEmail(account.email);
        if (email && email !== account.email && (updateEmail || service.updateAccountEmail))
          emailUpdates.push({ index, email, accessToken: credential.apiKey, updateEmail });
        const displayName = email ?? label;
        const accountHeading = `${details.shift()} · ${displayName}${account.active ? " [Current]" : ""} · ${authKind}`;
        results[index] =
          `${options.colorHeading?.(accountHeading) ?? accountHeading}\n${details.join("\n")}`;
      } catch (error) {
        options.signal?.throwIfAborted();
        hadLookupFailure = true;
        const reason =
          error instanceof UsageError
            ? error.message
            : "Account authentication or usage lookup failed.";
        results[index] = `${errorHeading}\nUsage unavailable. ${reason}`;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, () => worker()));
  options.signal?.throwIfAborted();
  // A removed account can disappear while requests are in flight. Recheck once,
  // but keep the report usable if account storage is briefly locked.
  let currentRoster: SavedUsageAccount[] | undefined;
  let currentAccounts: Map<string, SavedUsageAccount> | undefined;
  try {
    if (service.listAccounts) {
      currentRoster = await awaitWithAbort(service.listAccounts(), options.signal);
      currentAccounts = new Map(currentRoster.map((account) => [account.id, account]));
    }
  } catch {
    // The initial roster was valid; per-account errors remain visible.
  }
  options.signal?.throwIfAborted();
  const stillCurrent = (account: SavedUsageAccount, index: number) => {
    if (!currentAccounts) return true;
    const current = currentAccounts.get(account.id);
    return (
      !!current &&
      current.providerId === account.providerId &&
      current.label === account.label &&
      current.email === account.email &&
      current.active === account.active &&
      current.authKind === account.authKind &&
      (expectedRevisions[index] === undefined ||
        current.credentialRevision === expectedRevisions[index])
    );
  };
  const groups = new Map<string, string[]>();
  accounts.forEach((account, index) => {
    if (!stillCurrent(account, index)) return;
    const providerName =
      USAGE_PROVIDERS.find((provider) => provider.providerIds.includes(account.providerId))?.name ??
      account.providerId;
    const group = groups.get(providerName) ?? [];
    if (results[index]) group.push(results[index]!);
    groups.set(providerName, group);
  });
  const text = Array.from(groups.values(), (reports) => reports.join("\n\n"))
    .filter(Boolean)
    .join("\n\n");
  const validEmailUpdates = emailUpdates.filter((update) =>
    stillCurrent(accounts[update.index]!, update.index),
  );
  // The caller may cache against the final credential revisions only when
  // every original account is represented and all lookups succeeded. The
  // query cache owns shorter failure backoff; a failed report must not extend it.
  if (
    !hadLookupFailure &&
    currentRoster?.length === accounts.length &&
    currentRoster.every((current, index) => {
      const original = accounts[index]!;
      return (
        current.id === original.id &&
        current.providerId === original.providerId &&
        current.label === original.label &&
        current.authKind === original.authKind &&
        current.active === original.active &&
        current.email === original.email &&
        stillCurrent(original, index)
      );
    })
  ) {
    try {
      const projectedEmails = new Map(
        validEmailUpdates.map((update) => [accounts[update.index]!.id, update.email]),
      );
      options.onVerifiedRoster?.(
        currentRoster,
        currentRoster.map((account) => {
          const email = projectedEmails.get(account.id);
          return email ? { ...account, email } : account;
        }),
      );
    } catch {
      /* Cache publication must not hide a completed report. */
    }
  }
  // Email is optional metadata. Start writes only for accounts still present,
  // and let the completed quota report return without waiting for storage.
  for (const update of validEmailUpdates) {
    const account = accounts[update.index]!;
    void Promise.resolve()
      .then(() =>
        update.updateEmail
          ? update.updateEmail(update.email)
          : service.updateAccountEmail!(account.id, update.email, update.accessToken),
      )
      .catch(() => undefined);
  }
  return text;
}
