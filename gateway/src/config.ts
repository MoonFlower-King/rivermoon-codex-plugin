import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  mcpPath: string;
  oauthPrefix: string;
  issuer: string;
  resource: string;
  newApiBaseUrl: string;
  imageApiBaseUrl: string;
  standardGroup: string;
  proGroup: string;
  standardTokenName: string;
  proTokenName: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  stateFile: string;
  encryptionKey: Buffer;
  maxInlineImageBytes: number;
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function cleanPath(value: string): string {
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed.replace(/\/+$/, "") || "/";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.ENCRYPTION_KEY_BASE64?.trim();
  if (encoded) {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length !== 32) {
      throw new Error("ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
    }
    return decoded;
  }

  if (env.NODE_ENV === "test") {
    return createHash("sha256").update("rivermoon-test-key").digest();
  }

  if (env.NODE_ENV !== "production") {
    return randomBytes(32);
  }

  throw new Error("ENCRYPTION_KEY_BASE64 is required in production");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const publicBaseUrl = cleanBaseUrl(env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787");
  const mcpPath = cleanPath(env.MCP_PATH ?? "/codex-mcp");
  const oauthPrefix = cleanPath(env.OAUTH_PREFIX ?? "/codex-oauth");

  return {
    host: env.HOST ?? "127.0.0.1",
    port: positiveInt(env.PORT, 8787),
    publicBaseUrl,
    mcpPath,
    oauthPrefix,
    issuer: publicBaseUrl,
    resource: `${publicBaseUrl}${mcpPath}`,
    newApiBaseUrl: cleanBaseUrl(env.NEWAPI_BASE_URL ?? "http://127.0.0.1:3000"),
    imageApiBaseUrl: cleanBaseUrl(env.IMAGE_API_BASE_URL ?? "http://127.0.0.1:8320"),
    standardGroup: env.STANDARD_GROUP ?? "default",
    proGroup: env.PRO_GROUP ?? "4k",
    standardTokenName: env.STANDARD_TOKEN_NAME ?? "rivermoon-codex-standard",
    proTokenName: env.PRO_TOKEN_NAME ?? "rivermoon-codex-pro",
    accessTokenTtlSeconds: positiveInt(env.ACCESS_TOKEN_TTL_SECONDS, 3600),
    refreshTokenTtlSeconds: positiveInt(env.REFRESH_TOKEN_TTL_SECONDS, 2_592_000),
    stateFile: path.resolve(env.STATE_FILE ?? "./data/state.json"),
    encryptionKey: encryptionKey(env),
    maxInlineImageBytes: positiveInt(env.MAX_INLINE_IMAGE_BYTES, 16 * 1024 * 1024),
  };
}
