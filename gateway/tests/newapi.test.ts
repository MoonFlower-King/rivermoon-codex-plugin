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
});
