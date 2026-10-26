import { describe, expect, it } from "vitest";
import { LoginThrottle, loginAttemptKey } from "./login-throttle";

describe("login attempt throttling", () => {
  it("blocks repeated invalid attempts and releases the key after the block window", () => {
    let now = 1_000;
    const throttle = new LoginThrottle(2, 1_000, 2_000, 100, () => now);
    expect(throttle.recordFailure("login")).toBe(0);
    expect(throttle.recordFailure("login")).toBe(2);
    expect(throttle.retryAfter("login")).toBe(2);
    now += 2_001;
    expect(throttle.retryAfter("login")).toBe(0);
  });

  it("resets failures after a successful login", () => {
    const throttle = new LoginThrottle(2, 1_000, 2_000);
    throttle.recordFailure("login");
    throttle.reset("login");
    expect(throttle.recordFailure("login")).toBe(0);
  });

  it("keys attempts by normalized email and client address without retaining either", () => {
    expect(loginAttemptKey("127.0.0.1", " USER@example.com ")).toBe(loginAttemptKey("127.0.0.1", "user@example.com"));
    expect(loginAttemptKey("127.0.0.1", "user@example.com")).not.toContain("user@example.com");
    expect(loginAttemptKey("127.0.0.2", "user@example.com")).not.toBe(loginAttemptKey("127.0.0.1", "user@example.com"));
  });
});
