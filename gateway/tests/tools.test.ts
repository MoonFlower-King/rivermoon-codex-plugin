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
    encryptedStandardKey: "",
    encryptedProKey: "",
    expiresAt: Date.now() + 60_000,
  },
  standardKey: "sk-standard",
  proKey: "sk-pro",
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
