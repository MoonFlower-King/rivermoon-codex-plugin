import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ArtifactStore } from "./artifacts.js";
import type { AppConfig } from "./config.js";
import { decryptString } from "./crypto.js";
import { fetchWithRetry } from "./http.js";
import { NewApiClient, type ImageResult } from "./newapi.js";
import type { AccessGrant } from "./store.js";

export interface AuthorizedUser {
  grant: AccessGrant;
  standardKey: string;
  proKey: string;
  newApiSession: string;
}

const SIZE_PATTERN = /^(\d{3,4})x(\d{3,4})$/;
const RECOMMENDED_SIZES = ["1024x1024", "1024x1536", "1536x1024", "2048x2048"];
const SIZE_MESSAGE = `size must be "auto" or WIDTHxHEIGHT with each side between 256 and 4096 pixels, such as ${RECOMMENDED_SIZES.join(", ")}`;

export function isSupportedSize(value: string): boolean {
  if (value === "auto") return true;
  const match = SIZE_PATTERN.exec(value);
  if (!match) return false;
  return [match[1], match[2]].every((side) => {
    const pixels = Number(side);
    return pixels >= 256 && pixels <= 4096;
  });
}

const sizeSchema = z
  .string()
  .trim()
  .refine(isSupportedSize, { message: SIZE_MESSAGE })
  .default("auto")
  .describe(`Output size: "auto" or WIDTHxHEIGHT, such as ${RECOMMENDED_SIZES.join(", ")}`);

const sharedImageInput = {
  tier: z.enum(["standard", "pro"]).default("standard"),
  size: sizeSchema,
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
  output_format: z.enum(["png", "jpeg", "webp"]).default("png"),
  n: z.number().int().min(1).max(4).default(1).describe("How many images to return"),
};

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

async function imageBuffer(
  item: ImageResult["data"][number],
  newApi: NewApiClient,
): Promise<{ data: Buffer; mimeType: string } | undefined> {
  const mimeType = item.mime_type || "image/png";
  if (item.b64_json) return { data: Buffer.from(item.b64_json, "base64"), mimeType };
  if (!item.url) return undefined;

  const response = await fetchWithRetry(item.url, () => ({}), newApi.downloadPolicy);
  if (!response.ok) throw new Error(`Unable to download generated image (${response.status})`);
  return {
    data: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type")?.split(";", 1)[0] || mimeType,
  };
}

/**
 * Build the MCP content for a set of generated images. An image above the
 * inline limit is never dropped: it falls back to the upstream URL, or to a
 * short-lived gateway download link.
 */
async function imageContent(
  result: ImageResult,
  config: AppConfig,
  newApi: NewApiClient,
  artifacts: ArtifactStore,
): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [];
  content.push({
    type: "text",
    text: `RiverMoon generated ${result.data.length} image(s) with ${result.model ?? "gpt-image-2"}.`,
  });

  for (const item of result.data) {
    const image = await imageBuffer(item, newApi);
    if (!image) continue;

    if (image.data.byteLength <= config.maxInlineImageBytes) {
      content.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
      if (item.url) content.push({ type: "text", text: `Download: ${item.url}` });
      continue;
    }

    const oversized = `This image is ${formatBytes(image.data.byteLength)}, above the ${formatBytes(config.maxInlineImageBytes)} inline limit`;
    if (item.url) {
      content.push({ type: "text", text: `${oversized}. Download it from ${item.url}` });
      continue;
    }

    const stored = await artifacts.save(image.data, image.mimeType);
    if (!stored) {
      content.push({
        type: "text",
        text: `${oversized} and could not be cached for download. Retry with a smaller size.`,
      });
      continue;
    }

    const minutes = Math.max(1, Math.round(config.artifactTtlSeconds / 60));
    content.push({
      type: "text",
      text: `${oversized}. Download it within ${minutes} minutes from ${config.publicBaseUrl}${config.filesPath}/${stored.id}`,
    });
  }

  return content;
}

function tierKey(user: AuthorizedUser, tier: "standard" | "pro"): string {
  return tier === "pro" ? user.proKey : user.standardKey;
}

function quotaAmount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Turn raw NewAPI quota units into balances a user can read. */
export function describeAccount(
  account: Record<string, unknown>,
  config: AppConfig,
): { text: string; structured: Record<string, unknown> } {
  const remainingQuota = quotaAmount(account.quota);
  const usedQuota = quotaAmount(account.used_quota);
  const remainingUsd = remainingQuota === undefined ? undefined : remainingQuota / config.quotaPerUnit;
  const usedUsd = usedQuota === undefined ? undefined : usedQuota / config.quotaPerUnit;

  const estimate = (costUsd: number): number | undefined =>
    costUsd > 0 && remainingUsd !== undefined ? Math.floor(remainingUsd / costUsd) : undefined;
  const standardImagesLeft = estimate(config.standardImageCostUsd);
  const proImagesLeft = estimate(config.proImageCostUsd);

  const lines = [
    `RiverMoon account: ${account.username ?? "unknown"} (account group: ${account.group ?? "unknown"})`,
  ];
  lines.push(
    remainingUsd === undefined
      ? "Remaining balance: unavailable"
      : `Remaining balance: ${usd(remainingUsd)} (${remainingQuota} quota units)`,
  );
  if (usedUsd !== undefined) lines.push(`Used so far: ${usd(usedUsd)} (${usedQuota} quota units)`);
  if (standardImagesLeft !== undefined) {
    lines.push(`Roughly ${standardImagesLeft} more standard image(s) at ${usd(config.standardImageCostUsd)} each`);
  }
  if (proImagesLeft !== undefined) {
    lines.push(`Roughly ${proImagesLeft} more pro image(s) at ${usd(config.proImageCostUsd)} each`);
  }
  lines.push(`Tiers: standard uses group "${config.standardGroup}", pro uses group "${config.proGroup}"`);

  return {
    text: lines.join("\n"),
    structured: {
      username: account.username,
      account_group: account.group,
      remaining_quota: remainingQuota,
      remaining_usd: remainingUsd,
      used_quota: usedQuota,
      used_usd: usedUsd,
      quota_per_unit: config.quotaPerUnit,
      standard_group: config.standardGroup,
      pro_group: config.proGroup,
      estimated_standard_images_left: standardImagesLeft,
      estimated_pro_images_left: proImagesLeft,
    },
  };
}

export function createMcpServer(
  config: AppConfig,
  newApi: NewApiClient,
  artifacts: ArtifactStore,
  user: AuthorizedUser,
): McpServer {
  const server = new McpServer(
    { name: "rivermoon-image", version: "0.2.0" },
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
        ...sharedImageInput,
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
          content: (await imageContent(result, config, newApi, artifacts)) as never,
          structuredContent: {
            provider: "rivermoon",
            model: result.model ?? "gpt-image-2",
            tier,
            size,
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
        ...sharedImageInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, images, tier, size, quality, output_format, n }) => {
      try {
        const result = await newApi.editImage(tierKey(user, tier), {
          prompt,
          images,
          size,
          quality: quality === "auto" && tier === "pro" ? "high" : quality,
          outputFormat: output_format,
          n,
        });
        return {
          content: (await imageContent(result, config, newApi, artifacts)) as never,
          structuredContent: {
            provider: "rivermoon",
            model: result.model ?? "gpt-image-2",
            tier,
            size,
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
      description: "Check the authenticated RiverMoon account, tier groups, and remaining balance.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const account = await newApi.getAccount(user.newApiSession, user.grant.userId);
        const described = describeAccount(account, config);
        return {
          content: [{ type: "text", text: described.text }],
          structuredContent: described.structured,
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
