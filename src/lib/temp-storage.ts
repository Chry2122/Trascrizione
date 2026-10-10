import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export type StorageKind = "clean" | "verify";

const ROOT = path.join(process.cwd(), ".data");
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Returns the directory of a stored item, or null for ids that are not plain UUIDs. */
export function storageDir(kind: StorageKind, id: string): string | null {
  return ID_PATTERN.test(id) ? path.join(ROOT, kind, id) : null;
}

export async function createStorageDir(kind: StorageKind): Promise<{ id: string; dir: string }> {
  const id = randomUUID();
  const dir = path.join(ROOT, kind, id);
  await mkdir(dir, { recursive: true });
  return { id, dir };
}

export async function removeStorageDir(kind: StorageKind, id: string): Promise<void> {
  const dir = storageDir(kind, id);
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Deletes items older than a day: results nobody downloaded and abandoned uploads. */
export async function sweepOldStorage(kind: StorageKind): Promise<void> {
  const base = path.join(ROOT, kind);
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(base, entry.name);
        const info = await stat(dir).catch(() => null);
        if (info && now - info.mtimeMs > MAX_AGE_MS) {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }),
  );
}
