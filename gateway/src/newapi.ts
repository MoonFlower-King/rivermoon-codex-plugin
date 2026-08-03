import type { AppConfig } from "./config.js";

interface ApiEnvelope<T> {
  success?: boolean;
  message?: string;
  data?: T;
}

interface LoginUser {
  id: number;
  username: string;
  display_name?: string;
  group: string;
  require_2fa?: boolean;
}

export type LoginResult =
  | { kind: "success"; user: LoginUser; sessionCookie: string }
  | { kind: "2fa"; sessionCookie: string };

interface TokenItem {
  id: number;
  name: string;
  group: string;
  status: number;
}

export interface ImageResult {
  data: Array<{
    b64_json?: string;
    url?: string;
    mime_type?: string;
    revised_prompt?: string;
  }>;
  model?: string;
  created?: number;
}

export class NewApiClient {
  constructor(private readonly config: AppConfig) {}

  private async parseJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`RiverMoon returned non-JSON response (${response.status})`);
    }
    if (!response.ok) {
      const envelope = body as ApiEnvelope<unknown> & { error?: { message?: string } };
      const message = envelope.error?.message ?? envelope.message ?? text.slice(0, 300);
      throw new Error(`RiverMoon request failed (${response.status}): ${message}`);
    }
    return body as T;
  }

  private sessionCookie(response: Response): string {
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const cookies = getSetCookie?.call(response.headers) ?? [];
    const raw = cookies.length > 0 ? cookies : [response.headers.get("set-cookie") ?? ""];
    const session = raw.find((value) => value.startsWith("session="));
    if (!session) throw new Error("RiverMoon login did not return a session cookie");
    return session.split(";", 1)[0];
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const response = await fetch(`${this.config.newApiBaseUrl}/api/user/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await this.parseJson<ApiEnvelope<LoginUser>>(response);
    if (!body.success) throw new Error(body.message || "用户名或密码错误");
    const cookie = this.sessionCookie(response);
    if (body.data?.require_2fa) return { kind: "2fa", sessionCookie: cookie };
    if (!body.data?.id || !body.data.username) throw new Error("RiverMoon login response is incomplete");
    return { kind: "success", user: body.data, sessionCookie: cookie };
  }

  async verifyTwoFactor(sessionCookie: string, code: string): Promise<LoginResult> {
    const response = await fetch(`${this.config.newApiBaseUrl}/api/user/login/2fa`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({ code }),
    });
    const body = await this.parseJson<ApiEnvelope<LoginUser>>(response);
    if (!body.success || !body.data?.id) throw new Error(body.message || "两步验证码无效");
    const cookie = this.sessionCookie(response);
    return { kind: "success", user: body.data, sessionCookie: cookie };
  }

  private async sessionRequest<T>(
    path: string,
    sessionCookie: string,
    userId: number,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.config.newApiBaseUrl}${path}`, {
      ...init,
      headers: {
        cookie: sessionCookie,
        "New-Api-User": String(userId),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await this.parseJson<ApiEnvelope<T>>(response);
    if (!body.success) throw new Error(body.message || "RiverMoon account request failed");
    return body.data as T;
  }

  async getAccount(sessionCookie: string, userId: number): Promise<Record<string, unknown>> {
    return this.sessionRequest<Record<string, unknown>>("/api/user/self", sessionCookie, userId);
  }

  private async listTokens(sessionCookie: string, userId: number): Promise<TokenItem[]> {
    const page = await this.sessionRequest<{ items?: TokenItem[] } | TokenItem[]>(
      "/api/token/?p=1&size=100",
      sessionCookie,
      userId,
    );
    return Array.isArray(page) ? page : page.items ?? [];
  }

  private async createToken(
    sessionCookie: string,
    userId: number,
    name: string,
    group: string,
  ): Promise<void> {
    await this.sessionRequest<unknown>("/api/token/", sessionCookie, userId, {
      method: "POST",
      body: JSON.stringify({
        name,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: "gpt-image-2",
        allow_ips: "",
        group,
        cross_group_retry: false,
      }),
    });
  }

  private async tokenKey(sessionCookie: string, userId: number, tokenId: number): Promise<string> {
    const result = await this.sessionRequest<{ key: string }>(
      `/api/token/${tokenId}/key`,
      sessionCookie,
      userId,
      { method: "POST", body: "{}" },
    );
    if (!result.key) throw new Error("RiverMoon did not return the image token key");
    return result.key;
  }

  async ensureImageTokens(
    sessionCookie: string,
    userId: number,
  ): Promise<{ standardKey: string; proKey: string }> {
    let tokens = await this.listTokens(sessionCookie, userId);
    const requirements = [
      { name: this.config.standardTokenName, group: this.config.standardGroup },
      { name: this.config.proTokenName, group: this.config.proGroup },
    ];

    for (const requirement of requirements) {
      const existing = tokens.find(
        (token) => token.name === requirement.name && token.group === requirement.group,
      );
      if (!existing) {
        await this.createToken(sessionCookie, userId, requirement.name, requirement.group);
        tokens = await this.listTokens(sessionCookie, userId);
      }
    }

    const standard = tokens.find(
      (token) => token.name === this.config.standardTokenName && token.group === this.config.standardGroup,
    );
    const pro = tokens.find(
      (token) => token.name === this.config.proTokenName && token.group === this.config.proGroup,
    );
    if (!standard || !pro) throw new Error("Unable to provision RiverMoon image tokens");

    return {
      standardKey: await this.tokenKey(sessionCookie, userId, standard.id),
      proKey: await this.tokenKey(sessionCookie, userId, pro.id),
    };
  }

  private async imageRequest(path: string, apiKey: string, init: RequestInit): Promise<ImageResult> {
    const response = await fetch(`${this.config.imageApiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
    });
    const body = await this.parseJson<ImageResult & { error?: { message?: string } }>(response);
    if (body.error?.message) throw new Error(body.error.message);
    if (!Array.isArray(body.data) || body.data.length === 0) {
      throw new Error("RiverMoon image API returned no images");
    }
    return body;
  }

  async generateImage(
    apiKey: string,
    input: {
      prompt: string;
      size: string;
      quality: string;
      outputFormat: string;
      n: number;
    },
  ): Promise<ImageResult> {
    return this.imageRequest("/v1/images/generations", apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        output_format: input.outputFormat,
        response_format: "b64_json",
        n: input.n,
      }),
    });
  }

  async editImage(
    apiKey: string,
    input: {
      prompt: string;
      images: string[];
      size: string;
      quality: string;
      outputFormat: string;
    },
  ): Promise<ImageResult> {
    const form = new FormData();
    form.set("model", "gpt-image-2");
    form.set("prompt", input.prompt);
    form.set("size", input.size);
    form.set("quality", input.quality);
    form.set("output_format", input.outputFormat);
    form.set("response_format", "b64_json");

    for (let index = 0; index < input.images.length; index += 1) {
      const image = await this.loadImage(input.images[index]);
      const field = input.images.length === 1 ? "image" : "image[]";
      form.append(
        field,
        new Blob([Buffer.from(image.bytes)], { type: image.mimeType }),
        `reference-${index + 1}.${image.extension}`,
      );
    }

    return this.imageRequest("/v1/images/edits", apiKey, { method: "POST", body: form });
  }

  private async loadImage(value: string): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    extension: string;
  }> {
    if (/^https?:\/\//i.test(value)) {
      const response = await fetch(value);
      if (!response.ok) throw new Error(`Unable to download reference image (${response.status})`);
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0] || "image/png";
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mimeType,
        extension: mimeType.split("/", 2)[1] || "png",
      };
    }

    const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    const mimeType = match?.[1] ?? "image/png";
    const encoded = match?.[2] ?? value;
    return {
      bytes: new Uint8Array(Buffer.from(encoded, "base64")),
      mimeType,
      extension: mimeType.split("/", 2)[1] || "png",
    };
  }
}
