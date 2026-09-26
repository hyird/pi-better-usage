/** Optional display metadata only. Never use email to match or merge accounts. */
export function accountEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return email.length <= 254 &&
    /^[\x21-\x7e]+$/.test(email) &&
    /^[^@<>]+@[^@<>]+\.[^@<>]+$/.test(email)
    ? email
    : undefined;
}

export function emailFromToken(token: string): string | undefined {
  try {
    if (token.length > 65536) return undefined;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return (
      accountEmail(payload?.["https://api.openai.com/profile"]?.email) ??
      accountEmail(payload?.email)
    );
  } catch {
    return undefined;
  }
}
