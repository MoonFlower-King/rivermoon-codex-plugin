import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fetchPublicHttps, isPublicAddress, readBodyLimited } from "../src/net.js";
import { RateLimiter } from "../src/rate-limit.js";

describe("SSRF guard", () => {
  it("classifies internal and public addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  it("rejects non-HTTPS, credentialed and internal URLs before connecting", async () => {
    const options = { maxBytes: 1024, timeoutMs: 1000 };
    await expect(fetchPublicHttps("http://example.com/a.png", options)).rejects.toThrow("HTTPS");
    await expect(fetchPublicHttps("https://user:pw@example.com/a.png", options)).rejects.toThrow("credentials");
    await expect(fetchPublicHttps("https://127.0.0.1/a.png", options)).rejects.toThrow("non-public");
    await expect(fetchPublicHttps("https://[::1]/a.png", options)).rejects.toThrow("non-public");
    await expect(fetchPublicHttps("https://169.254.169.254/latest", options)).rejects.toThrow("non-public");
    await expect(fetchPublicHttps("https://localhost/a.png", options)).rejects.toThrow("non-public");
  });

  it("caps fetch bodies", async () => {
    const big = new Response(new Uint8Array(2048));
    await expect(readBodyLimited(big, 1024)).rejects.toThrow("limit");
    const small = new Response(new Uint8Array(16));
    expect((await readBodyLimited(small, 1024)).byteLength).toBe(16);
  });
});

describe("RateLimiter", () => {
  it("blocks after the limit and resets after the window", () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 1)).toBe(true);
    expect(limiter.take("a", 2)).toBe(false);
    expect(limiter.take("b", 2)).toBe(true);
    expect(limiter.take("a", 1001)).toBe(true);
  });
});

describe("gateway abuse limits", () => {
  let tempDir: string;
  let app: Awaited<ReturnType<typeof createApplication>>["app"];

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "rivermoon-gateway-sec-"));
    ({ app } = await createApplication(
      loadConfig({
        NODE_ENV: "test",
        PUBLIC_BASE_URL: "https://rivermoon7.com",
        STATE_FILE: path.join(tempDir, "state.json"),
      }),
    ));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rate limits dynamic client registration per IP", async () => {
    const body = { redirect_uris: ["http://127.0.0.1:43123/callback"], token_endpoint_auth_method: "none" };
    const statuses: number[] = [];
    for (let index = 0; index < 22; index += 1) {
      const response = await request(app).post("/codex-oauth/register").send(body);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
