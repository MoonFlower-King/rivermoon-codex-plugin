import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredArtifact {
  id: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  bytes: number;
  expiresAt: number;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const FILE_NAME = /^([a-f0-9]{32})\.([a-z0-9]{1,5})$/;

/**
 * Short-lived on-disk store for images that are too large to inline in an MCP
 * response. The server runs on a single small system disk, so the store is
 * capped by both age and total size and prunes on every write.
 */
export class ArtifactStore {
  constructor(
    private readonly directory: string,
    private readonly ttlMs: number,
    private readonly maxTotalBytes: number,
  ) {}

  async save(data: Buffer, mimeType: string): Promise<StoredArtifact | undefined> {
    if (data.byteLength > this.maxTotalBytes) return undefined;

    const extension = EXTENSIONS[mimeType.toLowerCase()] ?? "png";
    const id = randomBytes(16).toString("hex");
    const fileName = `${id}.${extension}`;
    const filePath = path.join(this.directory, fileName);

    await mkdir(this.directory, { recursive: true });
    await this.prune(data.byteLength);
    await writeFile(filePath, data, { mode: 0o600 });

    return {
      id,
      fileName,
      filePath,
      mimeType: MIME_TYPES[extension] ?? mimeType,
      bytes: data.byteLength,
      expiresAt: Date.now() + this.ttlMs,
    };
  }

  /** Resolve a public id to a file that still exists and has not expired. */
  async resolve(id: string): Promise<{ filePath: string; mimeType: string } | undefined> {
    if (!/^[a-f0-9]{32}$/.test(id)) return undefined;

    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return undefined;
    }

    const fileName = entries.find((entry) => FILE_NAME.exec(entry)?.[1] === id);
    if (!fileName) return undefined;

    const filePath = path.join(this.directory, fileName);
    const info = await stat(filePath).catch(() => undefined);
    if (!info || Date.now() - info.mtimeMs > this.ttlMs) return undefined;

    const extension = FILE_NAME.exec(fileName)?.[2] ?? "png";
    return { filePath, mimeType: MIME_TYPES[extension] ?? "application/octet-stream" };
  }

  /** Drop expired files, then oldest-first until `incomingBytes` fits the cap. */
  async prune(incomingBytes = 0): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return;
    }

    const now = Date.now();
    const files: Array<{ filePath: string; bytes: number; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!FILE_NAME.test(entry)) continue;
      const filePath = path.join(this.directory, entry);
      const info = await stat(filePath).catch(() => undefined);
      if (!info) continue;
      if (now - info.mtimeMs > this.ttlMs) {
        await rm(filePath, { force: true }).catch(() => undefined);
        continue;
      }
      files.push({ filePath, bytes: info.size, mtimeMs: info.mtimeMs });
    }

    let total = files.reduce((sum, file) => sum + file.bytes, 0) + incomingBytes;
    if (total <= this.maxTotalBytes) return;

    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files) {
      if (total <= this.maxTotalBytes) break;
      await rm(file.filePath, { force: true }).catch(() => undefined);
      total -= file.bytes;
    }
  }
}
