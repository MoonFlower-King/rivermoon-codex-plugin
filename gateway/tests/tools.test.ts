import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";
import { loadConfig } from "../src/config.js";
import { createMcpServer, type AuthorizedUser } from "../src/mcp.js";
import { NewApiClient } from "../src/newapi.js";

const user: AuthorizedUser = {
  grant: {
    tokenHash: "hash",
    clientId: "rm_test",
    scope: "image:generate",
    resource: "https://rivermoon7.com/codex-mcp",
    userId: 1,
    username: "rivermoon",
    encryptedNewApiSession: "",
    encryptedKeys: {},
    expiresAt: Date.now() + 60_000,
  },
  keys: { standard: "sk-standard", pro: "sk-pro", video: "sk-video" },
  newApiSession: "session=test",
};

async function connectedClient(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ NODE_ENV: "test", ...env });
  const artifacts = new ArtifactStore(
    config.artifactDir,
    config.artifactTtlSeconds * 1000,
    config.artifactMaxTotalBytes,
  );
  const server = createMcpServer(config, new NewApiClient(config), artifacts, user);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

describe("advertised tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes a JSON schema for every tool, including the validated size", async () => {
    const { client, close } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["account_status", "edit_image", "generate_image"]);

      for (const tool of tools.filter((candidate) => candidate.name !== "account_status")) {
        const properties = tool.inputSchema.properties as Record<string, unknown>;
        expect(Object.keys(properties)).toEqual(
          expect.arrayContaining(["prompt", "tier", "size", "quality", "output_format", "n"]),
        );
      }
    } finally {
      await close();
    }
  });

  it("rejects an unsupported size before calling the upstream API", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "a cat", size: "9000x9000" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("size must be");
    } finally {
      await close();
    }
  });

  it("hands back a download link instead of dropping an oversized image", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rivermoon-oversize-"));
    const oversized = Buffer.alloc(4096, 7).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ b64_json: oversized }], model: "gpt-image-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { client, close } = await connectedClient({
      PUBLIC_BASE_URL: "https://rivermoon7.com",
      MAX_INLINE_IMAGE_BYTES: "64",
      ARTIFACT_DIR: directory,
    });

    try {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "a cat", size: "1024x1024" },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content.some((entry) => entry.type === "image")).toBe(false);
      const link = content.find((entry) => entry.text?.includes("/codex-files/"))?.text ?? "";
      expect(link).toMatch(/https:\/\/rivermoon7\.com\/codex-files\/[a-f0-9]{32}/);
      expect(link).toContain("Download it within 30 minutes");
    } finally {
      await close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const videoEnv = {
  VIDEO_MODELS: "kling-v1,veo-3",
  VIDEO_POLL_INTERVAL_MS: "5",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("video tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stays hidden on a relay with no video models configured", async () => {
    const { client, close } = await connectedClient();
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("generate_video");
      expect(names).not.toContain("check_video");
    } finally {
      await close();
    }
  });

  it("appears once video models are configured", async () => {
    const { client, close } = await connectedClient(videoEnv);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "account_status",
        "check_video",
        "edit_image",
        "generate_image",
        "generate_video",
      ]);
    } finally {
      await close();
    }
  });

  it("polls until the job finishes and returns the video URL", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ task_id: "t-1", status: "processing" }, 201))
      .mockResolvedValueOnce(jsonResponse({ task_id: "t-1", status: "in_progress" }))
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: "t-1",
          status: "succeeded",
          url: "https://cdn.example/v.mp4",
          format: "mp4",
          metadata: { duration: 5 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { client, close } = await connectedClient({ ...videoEnv, VIDEO_INLINE_WAIT_MS: "60000" });
    try {
      const result = await client.callTool({
        name: "generate_video",
        arguments: { prompt: "an astronaut walking on the moon", duration: 5 },
      });

      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain("https://cdn.example/v.mp4");
      expect(result.structuredContent).toMatchObject({ task_id: "t-1", status: "succeeded" });

      const submit = fetchMock.mock.calls[0];
      expect(String(submit[0])).toContain("/v1/video/generations");
      expect(JSON.parse(String(submit[1]?.body))).toMatchObject({
        model: "kling-v1",
        prompt: "an astronaut walking on the moon",
        duration: 5,
      });
    } finally {
      await close();
    }
  });

  it("hands back a task id with a do-not-resubmit warning when the job outlives the wait budget", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ task_id: "t-2", status: "queued" }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const { client, close } = await connectedClient({ ...videoEnv, VIDEO_INLINE_WAIT_MS: "1" });
    try {
      const result = await client.callTool({
        name: "generate_video",
        arguments: { prompt: "a river at night" },
      });

      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result.content);
      expect(text).toContain("t-2");
      expect(text).toContain("check_video");
      expect(text).toContain("do not resubmit");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it("surfaces a failed job as an error instead of a silent success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ task_id: "t-3", status: "failed", error: { message: "content rejected" } }),
        ),
    );

    const { client, close } = await connectedClient(videoEnv);
    try {
      const result = await client.callTool({ name: "check_video", arguments: { task_id: "t-3" } });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("content rejected");
    } finally {
      await close();
    }
  });

  it("rejects a model the relay does not offer", async () => {
    const { client, close } = await connectedClient(videoEnv);
    try {
      const result = await client.callTool({
        name: "generate_video",
        arguments: { prompt: "a river", model: "sora-2" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("model must be one of");
    } finally {
      await close();
    }
  });
});
