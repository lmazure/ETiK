/** Replaces the server's secrets by `[redacted]` in a text written by the agent, before it is stored or returned. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  let result = text;
  for (const secret of secrets) {
    // Short values would match ordinary words; real tokens are long.
    if (secret && secret.length >= 8) result = result.split(secret).join("[redacted]");
  }
  return result;
}
