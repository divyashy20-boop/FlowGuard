import { createHash } from "node:crypto";

type AttemptWindow = { failures: number; startedAt: number; blockedUntil: number };

export class LoginThrottle {
  private readonly attempts = new Map<string, AttemptWindow>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly blockMs = 15 * 60_000,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  retryAfter(key: string) {
    const attempt = this.attempts.get(key);
    if (!attempt) return 0;
    const now = this.now();
    if (attempt.blockedUntil > now) return Math.ceil((attempt.blockedUntil - now) / 1000);
    if (now - attempt.startedAt >= this.windowMs || attempt.blockedUntil > 0) this.attempts.delete(key);
    return 0;
  }

  recordFailure(key: string) {
    const now = this.now();
    let attempt = this.attempts.get(key);
    if (!attempt || now - attempt.startedAt >= this.windowMs || (attempt.blockedUntil > 0 && attempt.blockedUntil <= now)) {
      attempt = { failures: 0, startedAt: now, blockedUntil: 0 };
    }
    attempt.failures += 1;
    if (attempt.failures >= this.limit) attempt.blockedUntil = now + this.blockMs;
    this.attempts.delete(key);
    this.attempts.set(key, attempt);
    this.evictExpired(now);
    return this.retryAfter(key);
  }

  reset(key: string) {
    this.attempts.delete(key);
  }

  private evictExpired(now: number) {
    for (const [key, attempt] of this.attempts) {
      if (attempt.blockedUntil <= now && now - attempt.startedAt >= this.windowMs) this.attempts.delete(key);
    }
    while (this.attempts.size > this.maxKeys) {
      const oldestKey = this.attempts.keys().next().value;
      if (oldestKey === undefined) break;
      this.attempts.delete(oldestKey);
    }
  }
}

export function loginAttemptKey(ip: string, email: string) {
  return createHash("sha256").update(`${ip}\0${email.trim().toLowerCase()}`).digest("hex");
}

export const loginThrottle = new LoginThrottle();
