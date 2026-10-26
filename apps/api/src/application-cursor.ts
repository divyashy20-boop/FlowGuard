export type ApplicationCursor = { createdAt: Date; id: string };

export function encodeApplicationCursor(cursor: ApplicationCursor) {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })).toString("base64url");
}

export function decodeApplicationCursor(value: string): ApplicationCursor | null {
  if (value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || !parsed.id.length || parsed.id.length > 100 || typeof parsed.createdAt !== "string") return null;
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) return null;
    return { id: parsed.id, createdAt };
  } catch {
    return null;
  }
}
