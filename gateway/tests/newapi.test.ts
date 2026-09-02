import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { NewApiClient } from "../src/newapi.js";

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, message: "", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("NewApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("provisions model-limited standard and 4k tokens", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [] }))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(
        response({ items: [{ id: 10, name: "rivermoon-codex-standard", group: "default", status: 1 }] }),
      )
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(
        response({
          items: [
            { id: 10, name: "rivermoon-codex-standard", group: "default", status: 1 },
            { id: 11, name: "rivermoon-codex-pro", group: "4k", status: 1 },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ key: "sk-standard" }))
      .mockResolvedValueOnce(response({ key: "sk-pro" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new NewApiClient(loadConfig({ NODE_ENV: "test" }));
    const keys = await client.ensureImageTokens("session=test", 123);

    expect(keys).toEqual({ standardKey: "sk-standard", proKey: "sk-pro" });
    const createBodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST" && String(init.body).includes("model_limits"))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(createBodies).toEqual([
      expect.objectContaining({ group: "default", model_limits: "gpt-image-2" }),
      expect.objectContaining({ group: "4k", model_limits: "gpt-image-2" }),
    ]);
  });

  it("returns the NewAPI login error without requiring a session cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ success: false, message: "用户名或密码错误" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const client = new NewApiClient(loadConfig({ NODE_ENV: "test" }));
    await expect(client.login("wrong", "wrong")).rejects.toThrow("用户名或密码错误");
  });

  it("retries an image request that was rejected before billing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }], model: "gpt-image-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new NewApiClient(loadConfig({ NODE_ENV: "test", RETRY_BASE_DELAY_MS: "1" }));
    const result = await client.generateImage("sk-standard", {
      prompt: "a cat",
      size: "auto",
      quality: "auto",
      outputFormat: "png",
      n: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry an image request that may have been billed", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "upstream exploded" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new NewApiClient(loadConfig({ NODE_ENV: "test", RETRY_BASE_DELAY_MS: "1" }));
    await expect(
      client.generateImage("sk-standard", {
        prompt: "a cat",
        size: "auto",
        quality: "auto",
        outputFormat: "png",
        n: 1,
      }),
    ).rejects.toThrow("upstream exploded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the requested image count when editing", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new NewApiClient(loadConfig({ NODE_ENV: "test" }));
    await client.editImage("sk-pro", {
      prompt: "make it night",
      images: [Buffer.from("png-bytes").toString("base64")],
      size: "1024x1024",
      quality: "high",
      outputFormat: "png",
      n: 3,
    });

    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get("n")).toBe("3");
    expect(form.get("size")).toBe("1024x1024");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });
});
