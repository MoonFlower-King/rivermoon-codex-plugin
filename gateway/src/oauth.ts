import { Router, type Request, type Response } from "express";
import type { AppConfig } from "./config.js";
import { decryptString, encryptString, pkceChallenge, randomToken, tokenHash } from "./crypto.js";
import { NewApiClient, type LoginResult } from "./newapi.js";
import {
  GatewayStore,
  type AccessGrant,
  type AuthorizationCode,
  type PendingAuthorization,
  type RefreshGrant,
} from "./store.js";

const SUPPORTED_SCOPES = ["image:generate", "image:edit", "account:read"];

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

function loginPage(requestId: string, error?: string): string {
  const message = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "<p>登录后，Codex 将为你的账户创建两个仅限图片模型的专用令牌。</p>";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>登录 RiverMoon</title>
  <style>
    body{margin:0;background:#f4f6f8;color:#17202a;font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}
    main{width:min(400px,calc(100% - 32px));background:#fff;border:1px solid #d9dee5;border-radius:8px;padding:28px;box-sizing:border-box}
    h1{font-size:24px;margin:0 0 8px}p{color:#52606d;margin:0 0 20px}.error{color:#b42318;background:#fef3f2;padding:10px;border-radius:6px}
    label{display:block;font-weight:600;margin:14px 0 6px}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #aeb7c2;border-radius:6px;font:inherit}
    button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:6px;background:#147d64;color:#fff;font:600 16px system-ui;cursor:pointer}
    small{display:block;color:#697586;margin-top:16px}a{color:#147d64}
  </style>
</head>
<body><main>
  <h1>RiverMoon</h1>
  ${message}
  <form method="post" action="./login">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <label for="username">用户名</label>
    <input id="username" name="username" autocomplete="username" required>
    <label for="password">密码</label>
    <input id="password" type="password" name="password" autocomplete="current-password" required>
    <button type="submit">登录并授权 Codex</button>
  </form>
  <small>还没有账号？<a href="https://rivermoon7.com/register" target="_blank" rel="noopener noreferrer">注册 RiverMoon</a></small>
  <small>密码只用于本次 RiverMoon 登录验证，不会保存到插件或 MCP 数据库。</small>
</main></body></html>`;
}

function twoFactorPage(requestId: string, error?: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>两步验证</title>
  <style>body{font:16px system-ui;background:#f4f6f8;display:grid;min-height:100vh;place-items:center}main{width:min(400px,calc(100% - 32px));background:#fff;border:1px solid #ddd;border-radius:8px;padding:28px;box-sizing:border-box}input,button{width:100%;box-sizing:border-box;padding:11px;margin-top:12px;font:inherit}button{background:#147d64;color:#fff;border:0;border-radius:6px}.error{color:#b42318}</style></head>
  <body><main><h1>两步验证</h1>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="./login/2fa"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="验证码或备用码" required><button type="submit">继续</button></form></main></body></html>`;
}

function successPage(): string {
  return "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>授权完成</title><body style=\"font:16px system-ui;padding:40px\"><h1>RiverMoon 已连接</h1><p>你可以关闭此页面并返回 Codex。</p></body></html>";
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return (
        url.hostname === "chatgpt.com" ||
        url.hostname.endsWith(".chatgpt.com") ||
        url.hostname === "openai.com" ||
        url.hostname.endsWith(".openai.com")
      );
    }
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function redirectWithCode(pending: PendingAuthorization, code: string): string {
  const redirect = new URL(pending.redirectUri);
  redirect.searchParams.set("code", code);
  if (pending.state) redirect.searchParams.set("state", pending.state);
  return redirect.toString();
}

export function createOAuthRouter(
  config: AppConfig,
  store: GatewayStore,
  newApi: NewApiClient,
): Router {
  const router = Router();

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: SUPPORTED_SCOPES,
    });
  });

  const authorizationMetadata = {
    issuer: config.issuer,
    authorization_endpoint: `${config.publicBaseUrl}${config.oauthPrefix}/authorize`,
    token_endpoint: `${config.publicBaseUrl}${config.oauthPrefix}/token`,
    registration_endpoint: `${config.publicBaseUrl}${config.oauthPrefix}/register`,
    revocation_endpoint: `${config.publicBaseUrl}${config.oauthPrefix}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: SUPPORTED_SCOPES,
  };

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationMetadata);
  });

  router.post(`${config.oauthPrefix}/register`, async (req, res) => {
    const redirectUris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.filter((value: unknown): value is string => typeof value === "string")
      : [];
    if (redirectUris.length === 0 || redirectUris.some((uri: string) => !validRedirectUri(uri))) {
      return oauthError(res, 400, "invalid_redirect_uri", "At least one valid redirect URI is required");
    }
    if (req.body?.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== "none") {
      return oauthError(res, 400, "invalid_client_metadata", "Only public PKCE clients are supported");
    }

    const clientId = `rm_${randomToken(24)}`;
    await store.putClient({ clientId, redirectUris, createdAt: Date.now() });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  router.get(`${config.oauthPrefix}/authorize`, async (req, res) => {
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const responseType = String(req.query.response_type ?? "");
    const codeChallenge = String(req.query.code_challenge ?? "");
    const codeChallengeMethod = String(req.query.code_challenge_method ?? "");
    const resource = String(req.query.resource ?? config.resource);
    const client = store.getClient(clientId);

    if (!client || !client.redirectUris.includes(redirectUri)) {
      return oauthError(res, 400, "invalid_client", "Unknown client or redirect URI");
    }
    if (responseType !== "code" || codeChallengeMethod !== "S256" || !codeChallenge) {
      return oauthError(res, 400, "invalid_request", "Authorization code with PKCE S256 is required");
    }
    if (resource !== config.resource) {
      return oauthError(res, 400, "invalid_target", "The requested resource is not supported");
    }

    const requestedScopes = String(req.query.scope ?? SUPPORTED_SCOPES.join(" "))
      .split(/\s+/)
      .filter(Boolean);
    if (requestedScopes.some((scope) => !SUPPORTED_SCOPES.includes(scope))) {
      return oauthError(res, 400, "invalid_scope", "One or more requested scopes are unsupported");
    }

    const pending: PendingAuthorization = {
      id: randomToken(24),
      clientId,
      redirectUri,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      scope: requestedScopes.join(" "),
      resource,
      codeChallenge,
      codeChallengeMethod: "S256",
      createdAt: Date.now(),
    };
    await store.putPending(pending);
    res.type("html").send(loginPage(pending.id));
  });

  async function completeLogin(
    res: Response,
    pending: PendingAuthorization,
    result: Extract<LoginResult, { kind: "success" }>,
  ): Promise<void> {
    const imageTokens = await newApi.ensureImageTokens(result.sessionCookie, result.user.id);
    const rawCode = randomToken(32);
    const code: AuthorizationCode = {
      codeHash: tokenHash(rawCode),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      scope: pending.scope,
      resource: pending.resource,
      codeChallenge: pending.codeChallenge,
      userId: result.user.id,
      username: result.user.username,
      encryptedNewApiSession: encryptString(result.sessionCookie, config.encryptionKey),
      encryptedStandardKey: encryptString(imageTokens.standardKey, config.encryptionKey),
      encryptedProKey: encryptString(imageTokens.proKey, config.encryptionKey),
      expiresAt: Date.now() + 5 * 60_000,
    };
    await store.putCode(code);
    await store.deletePending(pending.id);
    const target = redirectWithCode(pending, rawCode);
    if (target.startsWith("http://") || target.startsWith("https://")) {
      res.redirect(target);
      return;
    }
    res.type("html").send(successPage());
  }

  router.post(`${config.oauthPrefix}/login`, async (req, res) => {
    const requestId = String(req.body?.request_id ?? "");
    const pending = store.getPending(requestId);
    if (!pending || pending.createdAt + 10 * 60_000 <= Date.now()) {
      return res.status(400).type("html").send(loginPage(requestId, "授权请求已过期，请返回 Codex 重试。"));
    }
    try {
      const result = await newApi.login(String(req.body?.username ?? ""), String(req.body?.password ?? ""));
      if (result.kind === "2fa") {
        await store.updatePending(requestId, {
          encryptedNewApiSession: encryptString(result.sessionCookie, config.encryptionKey),
        });
        return res.type("html").send(twoFactorPage(requestId));
      }
      await completeLogin(res, pending, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      res.status(401).type("html").send(loginPage(requestId, message));
    }
  });

  router.post(`${config.oauthPrefix}/login/2fa`, async (req, res) => {
    const requestId = String(req.body?.request_id ?? "");
    const pending = store.getPending(requestId);
    if (!pending?.encryptedNewApiSession) {
      return res.status(400).type("html").send(twoFactorPage(requestId, "两步验证会话已过期。"));
    }
    try {
      const session = decryptString(pending.encryptedNewApiSession, config.encryptionKey);
      const result = await newApi.verifyTwoFactor(session, String(req.body?.code ?? ""));
      if (result.kind !== "success") throw new Error("两步验证未完成");
      await completeLogin(res, pending, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "两步验证失败";
      res.status(401).type("html").send(twoFactorPage(requestId, message));
    }
  });

  async function issueTokens(
    source: Omit<AccessGrant, "tokenHash" | "expiresAt">,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(40);
    const access: AccessGrant = {
      ...source,
      tokenHash: tokenHash(accessToken),
      expiresAt: Date.now() + config.accessTokenTtlSeconds * 1000,
    };
    const refresh: RefreshGrant = {
      ...source,
      tokenHash: tokenHash(refreshToken),
      expiresAt: Date.now() + config.refreshTokenTtlSeconds * 1000,
    };
    await store.putAccessToken(access);
    await store.putRefreshToken(refresh);
    return { accessToken, refreshToken };
  }

  router.post(`${config.oauthPrefix}/token`, async (req, res) => {
    const grantType = String(req.body?.grant_type ?? "");
    if (grantType === "authorization_code") {
      const rawCode = String(req.body?.code ?? "");
      const code = await store.consumeCode(tokenHash(rawCode));
      if (!code || code.expiresAt <= Date.now()) {
        return oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired");
      }
      if (
        code.clientId !== String(req.body?.client_id ?? "") ||
        code.redirectUri !== String(req.body?.redirect_uri ?? "") ||
        pkceChallenge(String(req.body?.code_verifier ?? "")) !== code.codeChallenge ||
        String(req.body?.resource ?? code.resource) !== code.resource
      ) {
        return oauthError(res, 400, "invalid_grant", "Authorization code validation failed");
      }

      const issued = await issueTokens({
        clientId: code.clientId,
        scope: code.scope,
        resource: code.resource,
        userId: code.userId,
        username: code.username,
        encryptedNewApiSession: code.encryptedNewApiSession,
        encryptedStandardKey: code.encryptedStandardKey,
        encryptedProKey: code.encryptedProKey,
      });
      return res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: issued.refreshToken,
        scope: code.scope,
      });
    }

    if (grantType === "refresh_token") {
      const previous = await store.consumeRefreshToken(tokenHash(String(req.body?.refresh_token ?? "")));
      if (!previous) return oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired");
      const clientId = String(req.body?.client_id ?? previous.clientId);
      if (clientId !== previous.clientId) {
        return oauthError(res, 400, "invalid_client", "Refresh token client does not match");
      }
      const issued = await issueTokens({
        clientId: previous.clientId,
        scope: previous.scope,
        resource: previous.resource,
        userId: previous.userId,
        username: previous.username,
        encryptedNewApiSession: previous.encryptedNewApiSession,
        encryptedStandardKey: previous.encryptedStandardKey,
        encryptedProKey: previous.encryptedProKey,
      });
      return res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: issued.refreshToken,
        scope: previous.scope,
      });
    }

    oauthError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported");
  });

  router.post(`${config.oauthPrefix}/revoke`, async (req, res) => {
    const token = String(req.body?.token ?? "");
    if (token) await store.revokeToken(tokenHash(token));
    res.status(200).send();
  });

  return router;
}
