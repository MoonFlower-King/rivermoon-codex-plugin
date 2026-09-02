import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";

describe("ArtifactStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "rivermoon-artifacts-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("stores an image and resolves it by id", async () => {
    const store = new ArtifactStore(directory, 60_000, 1024 * 1024);
    const stored = await store.save(Buffer.from("image-bytes"), "image/webp");

    expect(stored?.id).toMatch(/^[a-f0-9]{32}$/);
    const resolved = await store.resolve(stored!.id);
    expect(resolved?.mimeType).toBe("image/webp");
    expect(resolved?.filePath).toBe(stored!.filePath);
  });

  it("refuses ids that are not artifact ids", async () => {
    const store = new ArtifactStore(directory, 60_000, 1024 * 1024);
    await store.save(Buffer.from("image-bytes"), "image/png");

    expect(await store.resolve("../../etc/passwd")).toBeUndefined();
    expect(await store.resolve("not-an-id")).toBeUndefined();
  });

  it("expires a file once it is older than the TTL", async () => {
    const store = new ArtifactStore(directory, 1_000, 1024 * 1024);
    const stored = await store.save(Buffer.from("image-bytes"), "image/png");

    const stale = new Date(Date.now() - 10_000);
    await utimes(stored!.filePath, stale, stale);

    expect(await store.resolve(stored!.id)).toBeUndefined();
    await store.prune();
    expect(await readdir(directory)).toHaveLength(0);
  });

  it("drops the oldest files when the total size cap is exceeded", async () => {
    const store = new ArtifactStore(directory, 60_000, 40);
    const first = await store.save(Buffer.alloc(20, 1), "image/png");
    const older = new Date(Date.now() - 5_000);
    await utimes(first!.filePath, older, older);

    await store.save(Buffer.alloc(20, 2), "image/png");
    await store.save(Buffer.alloc(20, 3), "image/png");

    const remaining = await readdir(directory);
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(first!.fileName);
  });

  it("declines an image larger than the whole cache", async () => {
    const store = new ArtifactStore(directory, 60_000, 10);
    expect(await store.save(Buffer.alloc(64), "image/png")).toBeUndefined();
  });
});
