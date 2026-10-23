import { createHash, timingSafeEqual } from "node:crypto";

export class AuthError extends Error {
  constructor(readonly status: 401, message: string) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The single static bearer token of the callers. */
export class Authenticator {
  private readonly expected: Buffer;

  constructor(token: string) {
    this.expected = digest(token);
  }

  /** Checks the `Authorization: Bearer …` header; throws a 401 AuthError when missing or wrong. */
  authenticate(authorization: string | undefined): void {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!match) throw new AuthError(401, "Missing bearer token (Authorization: Bearer <token>)");
    if (!timingSafeEqual(this.expected, digest(match[1]!.trim()))) throw new AuthError(401, "Invalid bearer token");
  }
}
