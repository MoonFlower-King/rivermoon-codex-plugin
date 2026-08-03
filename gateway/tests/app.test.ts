import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("RiverMoon gateway", () => {
  let tempDir: string;
  let app: Awaited<ReturnType<typeof createApplication>>["app"];

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "rivermoon-gateway-"));
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "https://rivermoon7.com",
      STATE_FILE: path.join(tempDir, "state.json"),
    });
    ({ app } = await createApplication(config));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("publishes protected resource metadata", async () => {
    const response = await request(app).get("/.well-known/oauth-protected-resource").expect(200);
    expect(response.body.resource).toBe("https://rivermoon7.com/codex-mcp");
    expect(response.body.authorization_servers).toEqual(["https://rivermoon7.com"]);
  });

  it("registers a public PKCE OAuth client", async () => {
    const response = await request(app)
      .post("/codex-oauth/register")
      .send({
        redirect_uris: ["http://127.0.0.1:43123/callback"],
        token_endpoint_auth_method: "none",
      })
      .expect(201);

    expect(response.body.client_id).toMatch(/^rm_/);
    expect(response.body.token_endpoint_auth_method).toBe("none");
  });

  it("rejects arbitrary HTTPS redirect targets", async () => {
    await request(app)
      .post("/codex-oauth/register")
      .send({ redirect_uris: ["https://example.com/callback"], token_endpoint_auth_method: "none" })
      .expect(400);
  });

  it("shows the RiverMoon registration link during authorization", async () => {
    const registered = await request(app)
      .post("/codex-oauth/register")
      .send({
        redirect_uris: ["http://127.0.0.1:43124/callback"],
        token_endpoint_auth_method: "none",
      })
      .expect(201);

    const response = await request(app)
      .get("/codex-oauth/authorize")
      .query({
        client_id: registered.body.client_id,
        redirect_uri: "http://127.0.0.1:43124/callback",
        response_type: "code",
        code_challenge: "test-challenge",
        code_challenge_method: "S256",
      })
      .expect(200);

    expect(response.text).toContain("https://rivermoon7.com/register");
  });

  it("rejects an MCP request without OAuth", async () => {
    const response = await request(app)
      .post("/codex-mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401);

    expect(response.headers["www-authenticate"]).toContain("oauth-protected-resource");
  });
});
