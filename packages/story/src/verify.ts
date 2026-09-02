const VERIFY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const VERIFY_PREFIX = "FF-";

export function generateVerifyCode(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(4))): string {
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    const byte = bytes[i] ?? 0;
    code += VERIFY_ALPHABET[byte % VERIFY_ALPHABET.length];
  }
  return code;
}

export function formatVerifyToken(code: string): string {
  const trimmed = code.replace(/^FF-/i, "").toUpperCase();
  return `${VERIFY_PREFIX}${trimmed}`;
}

export function teamNameHasToken(teamName: string | undefined | null, token: string): boolean {
  if (!teamName) return false;
  return teamName.toUpperCase().includes(token.toUpperCase());
}

export type VerifiableLeagueUser = {
  user_id: string;
  username: string;
  metadata?: { team_name?: string | null } | null;
};

export type VerifyResult =
  | { ok: true; sleeperUserId: string; teamName: string }
  | { ok: false; reason: "not_found" | "missing_token" };

export function verifySleeperTeamName(
  users: VerifiableLeagueUser[],
  sleeperUsername: string,
  token: string,
): VerifyResult {
  const expected = formatVerifyToken(token);
  const user = users.find((entry) => entry.username.toLowerCase() === sleeperUsername.toLowerCase());
  if (!user) {
    return { ok: false, reason: "not_found" };
  }
  const teamName = user.metadata?.team_name ?? "";
  if (!teamNameHasToken(teamName, expected)) {
    return { ok: false, reason: "missing_token" };
  }
  return { ok: true, sleeperUserId: user.user_id, teamName };
}
