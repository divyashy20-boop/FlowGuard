import { describe, expect, it } from "vitest";
import { decodeApplicationCursor, encodeApplicationCursor } from "./application-cursor";

describe("application keyset cursor", () => {
  it("round-trips a timestamp and record id", () => {
    const value = { id: "application-1", createdAt: new Date("2026-10-26T12:00:00.000Z") };
    expect(decodeApplicationCursor(encodeApplicationCursor(value))).toEqual(value);
  });

  it("rejects malformed, incomplete, and oversized cursors", () => {
    expect(decodeApplicationCursor("not-json")).toBeNull();
    expect(decodeApplicationCursor(Buffer.from('{"id":"x"}').toString("base64url"))).toBeNull();
    expect(decodeApplicationCursor("x".repeat(513))).toBeNull();
  });
});
