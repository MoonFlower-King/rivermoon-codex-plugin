import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { tokenHash } from "./crypto.js";
import { authorizeGrant, createMcpServer, type AuthorizedUser } from "./mcp.js";
import { NewApiClient } from "./newapi.js";
import { createOAuthRouter } from "./oauth.js";
import { GatewayStore } from "./store.js";

declare global {
  namespace Express {
    interface Request {
      rivermoonUser?: AuthorizedUser;
    }
  }
}

export async function createApplication(config: AppConfig) {
  const store = await GatewayStore.open(config.stateFile);
  const newApi = new NewApiClient(config);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(createOAuthRouter(config, store, newApi));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "rivermoon-codex-image", version: "0.1.0" });
  });

  const requireAccessToken = (req: Request, res: Response, next: NextFunction) => {
    const match = req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
    const grant = match ? store.getAccessToken(tokenHash(match[1])) : undefined;
    if (!grant) {
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", scope="image:generate image:edit account:read"`,
        )
        .json({ error: "unauthorized", message: "RiverMoon authentication is required" });
      return;
    }
    try {
      req.rivermoonUser = authorizeGrant(config, grant);
      next();
    } catch {
      res.status(401).json({ error: "unauthorized", message: "Stored RiverMoon credentials are invalid" });
    }
  };

  app.post(config.mcpPath, requireAccessToken, async (req, res) => {
    const server = createMcpServer(config, newApi, req.rivermoonUser!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });

  app.get(config.mcpPath, requireAccessToken, (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });
  app.delete(config.mcpPath, requireAccessToken, (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled gateway error", error);
    res.status(500).json({ error: "server_error", message: "RiverMoon gateway error" });
  });

  const pruneTimer = setInterval(() => void store.prune(), 10 * 60_000);
  pruneTimer.unref();
  return { app, store, newApi };
}
