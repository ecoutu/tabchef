/** Replaces secrets in strings that may leave ConnectionManager (errors, statuses, logs). */
export const REDACTED = '«redacted»';

/**
 * GitHub (ghp_/gho_/ghr_/ghs_/ghu_/github_pat_) and Atlassian (ATATT) token shapes. Shared with the check-no-secrets script.
 * Global: use with String.replace / matchAll only (they reset lastIndex), not .test().
 */
export const TOKEN_PATTERN = /(gh[oprsu]_|github_pat_)[A-Za-z0-9_]{10,}|ATATT[A-Za-z0-9_\-=]{10,}/g;

/** Standard base64 of the UTF-8 bytes of `s` (what `Authorization: Basic` carries). */
export function base64Utf8(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Replaces each secret, its base64 (padded and unpadded), and anything token-shaped with «redacted». Pass a Jira
 * `email:token` pair as a secret to catch its Basic header (SecretStore.knownSecrets includes it).
 */
export function redact(s: string, secrets: string[]): string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    const b64 = base64Utf8(secret);
    needles.add(secret).add(b64).add(b64.replace(/=+$/, ''));
  }
  let out = s;
  for (const n of [...needles].sort((a, b) => b.length - a.length)) out = out.split(n).join(REDACTED);
  return out.replace(TOKEN_PATTERN, REDACTED);
}
