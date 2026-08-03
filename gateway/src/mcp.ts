import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { decryptString } from "./crypto.js";
import { NewApiClient, type ImageResult } from "./newapi.js";
import type { AccessGrant } from "./store.js";

export interface AuthorizedUser {
  grant: AccessGrant;
  standardKey: string;
  proKey: string;
  newApiSession: string;
}

async function imageContent(
  result: ImageResult,
  maxInlineBytes: number,
): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "text",
    text: `RiverMoon generated ${result.data.length} image(s) with ${result.model ?? "gpt-image-2"}.`,
  });

  for (const item of result.data) {
    let encoded = item.b64_json;
    let mimeType = item.mime_type || "image/png";
    if (!encoded && item.url) {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`Unable to download generated image (${response.status})`);
      mimeType = response.headers.get("content-type")?.split(";", 1)[0] || mimeType;
      encoded = Buffer.from(await response.arrayBuffer()).toString("base64");
    }
    if (!encoded) continue;
    const byteLength = Buffer.byteLength(encoded, "base64");
    if (byteLength > maxInlineBytes) {
      content.push({
        type: "text",
        text: item.url
          ? `The generated image is too large to inline. Download it from ${item.url}`
          : `A generated image exceeded the ${maxInlineBytes} byte inline limit. Retry with a smaller size.`,
      });
      continue;
    }
    content.push({ type: "image", data: encoded, mimeType });
    if (item.url) content.push({ type: "text", text: `Download: ${item.url}` });
  }
  return content;
}

function tierKey(user: AuthorizedUser, tier: "standard" | "pro"): string {
  return tier === "pro" ? user.proKey : user.standardKey;
}

export function createMcpServer(
  config: AppConfig,
  newApi: NewApiClient,
  user: AuthorizedUser,
): McpServer {
  const server = new McpServer(
    { name: "rivermoon-image", version: "0.1.0" },
    {
      instructions:
        "Use RiverMoon for image generation and image editing. Use standard for drafts and routine images; use pro for final, high-detail, or 4K requests. Never claim an image was created unless the tool returned image content.",
    },
  );

  server.registerTool(
    "generate_image",
    {
      title: "Generate an image with RiverMoon",
      description:
        "Generate images with RiverMoon GPT Image 2. Choose standard for normal cost and pro for the higher-quality 4K group.",
      inputSchema: {
        prompt: z.string().min(1).max(32_000).describe("Complete image prompt"),
        tier: z.enum(["standard", "pro"]).default("standard"),
        size: z.string().default("auto").describe("Output size such as 1024x1024, 1536x1024, 2048x2048, or auto"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
        output_format: z.enum(["png", "jpeg", "webp"]).default("png"),
        n: z.number().int().min(1).max(4).default(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, tier, size, quality, output_format, n }) => {
      try {
        const result = await newApi.generateImage(tierKey(user, tier), {
          prompt,
          size,
          quality: quality === "auto" && tier === "pro" ? "high" : quality,
          outputFormat: output_format,
          n,
        });
        return {
          content: (await imageContent(result, config.maxInlineImageBytes)) as never,
          structuredContent: {
            provider: "rivermoon",
            model: result.model ?? "gpt-image-2",
            tier,
            count: result.data.length,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "RiverMoon image generation failed",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "edit_image",
    {
      title: "Edit images with RiverMoon",
      description:
        "Edit one or more reference images with RiverMoon GPT Image 2. References may be HTTPS URLs, data URLs, or raw base64 strings.",
      inputSchema: {
        prompt: z.string().min(1).max(32_000),
        images: z.array(z.string().min(1)).min(1).max(20),
        tier: z.enum(["standard", "pro"]).default("standard"),
        size: z.string().default("auto"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
        output_format: z.enum(["png", "jpeg", "webp"]).default("png"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, images, tier, size, quality, output_format }) => {
      try {
        const result = await newApi.editImage(tierKey(user, tier), {
          prompt,
          images,
          size,
          quality: quality === "auto" && tier === "pro" ? "high" : quality,
          outputFormat: output_format,
        });
        return {
          content: (await imageContent(result, config.maxInlineImageBytes)) as never,
          structuredContent: {
            provider: "rivermoon",
            model: result.model ?? "gpt-image-2",
            tier,
            references: images.length,
            count: result.data.length,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "RiverMoon image editing failed",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "account_status",
    {
      title: "Check RiverMoon account status",
      description: "Check the authenticated RiverMoon account, group, and remaining quota.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const account = await newApi.getAccount(user.newApiSession, user.grant.userId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  username: account.username,
                  group: account.group,
                  quota: account.quota,
                  used_quota: account.used_quota,
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: account,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "Unable to read RiverMoon account status",
            },
          ],
        };
      }
    },
  );

  return server;
}

export function authorizeGrant(config: AppConfig, grant: AccessGrant): AuthorizedUser {
  return {
    grant,
    standardKey: decryptString(grant.encryptedStandardKey, config.encryptionKey),
    proKey: decryptString(grant.encryptedProKey, config.encryptionKey),
    newApiSession: decryptString(grant.encryptedNewApiSession, config.encryptionKey),
  };
}
