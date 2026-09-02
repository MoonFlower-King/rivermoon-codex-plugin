import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, UpstreamTimeoutError } from "../src/http.js";

const policy = {
  timeoutMs: 1_000,
  retries: 2,
  baseDelayMs: 1,
  maxDelayMs: 5,
  retryOnTimeout: true,
};

function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

describe("fetchWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries a transient status and returns the eventual success", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/x", () => ({}), policy);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the last response instead of retrying forever", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/x", () => ({}), policy);

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(policy.retries + 1);
  });

  it("does not retry a status outside the configured set", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/x", () => ({}), {
      ...policy,
      retryStatuses: new Set([429]),
    });

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a timeout without retrying when retryOnTimeout is off", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(timeoutError());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("https://example.test/x", () => ({}), { ...policy, retryOnTimeout: false }),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal so a hung upstream cannot block the request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry("https://example.test/x", () => ({ method: "POST" }), policy);

    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rebuilds the request body on every attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 502 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const init = vi.fn(() => ({ method: "POST", body: "payload" }));
    await fetchWithRetry("https://example.test/x", init, policy);

    expect(init).toHaveBeenCalledTimes(2);
  });
});
