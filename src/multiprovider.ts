import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Soft bridge to pi-multiprovider, mirroring the pattern its sibling usage
 * extensions use. The event carries an announcement object; without
 * pi-multiprovider installed nothing here fires and credential resolution keeps
 * its standalone behavior.
 */
export const MULTIPROVIDER_SERVICE_EVENT = "pi-multiprovider:service";

export type MultiproviderActiveAccount = { id: string; label: string; authKind: string };

export type MultiproviderAccountAuth = { accessToken: string; label: string; source?: string };

export type MultiproviderAccountChangedEvent = {
  providerId: string;
  account: MultiproviderActiveAccount | undefined;
  ctx: ExtensionContext;
};

export type MultiproviderServiceContext = Pick<
  ExtensionContext,
  "modelRegistry" | "model" | "sessionManager"
>;

export type MultiproviderService = {
  getActiveAccount(
    providerId: string,
    ctx: MultiproviderServiceContext,
  ): Promise<MultiproviderActiveAccount | undefined>;
  resolveActiveAccountAuth(
    providerId: string,
    ctx: MultiproviderServiceContext,
    signal?: AbortSignal,
  ): Promise<MultiproviderAccountAuth | undefined>;
  onActiveAccountChanged(
    providerId: string,
    callback: (event: MultiproviderAccountChangedEvent) => void,
  ): () => void;
};

export function isMultiproviderService(value: unknown): value is MultiproviderService {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MultiproviderService>;
  return (
    typeof candidate.getActiveAccount === "function" &&
    typeof candidate.resolveActiveAccountAuth === "function" &&
    typeof candidate.onActiveAccountChanged === "function"
  );
}
