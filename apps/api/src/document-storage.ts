import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface DocumentStorage {
  put(bytes: Buffer): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

const root = path.resolve(process.env.FLOWGUARD_STORAGE_DIR || path.resolve(__dirname, "../../../private-uploads"));
const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveKey(key: string) {
  if (!keyPattern.test(key)) throw new Error("Invalid private storage key");
  const resolved = path.resolve(root, key);
  if (path.dirname(resolved) !== root) throw new Error("Invalid private storage key");
  return resolved;
}

export const localDocumentStorage: DocumentStorage = {
  async put(bytes) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    await fs.writeFile(resolveKey(key), bytes, { flag: "wx", mode: 0o600 });
    return key;
  },
  read(key) {
    return fs.readFile(resolveKey(key));
  },
  async remove(key) {
    await fs.unlink(resolveKey(key)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
};

export function safeDisplayName(value: string) {
  const normalized = path.posix.basename(value.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (normalized || "document").slice(0, 255);
}
