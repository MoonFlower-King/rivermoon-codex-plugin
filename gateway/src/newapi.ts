import type { AppConfig, UpstreamChannel } from "./config.js";
import { fetchWithRetry, type RetryPolicy } from "./http.js";

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

export type VideoStatus = "queued" | "processing" | "in_progress" | "succeeded" | "failed";

export interface VideoTask {
  taskId: string;
  status: VideoStatus;
  url?: string;
  format?: string;
  model?: string;
  metadata?: Record<string, unknown>;
  error?: string;
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

/**
 * Image generation is charged per call, so it only retries statuses that mean
 * the request was rejected before any image was produced.
 */
const IMAGE_RETRY_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export class NewApiClient {
  constructor(private readonly config: AppConfig) {}

  /** Idempotent reads: safe to retry, including after a timeout. */
  private get readPolicy(): RetryPolicy {
    return {
      timeoutMs: this.config.upstreamTimeoutMs,
      retries: this.config.upstreamRetries,
      baseDelayMs: this.config.retryBaseDelayMs,
      maxDelayMs: this.config.retryMaxDelayMs,
      retryOnTimeout: true,
    };
  }

  /** Logins and token creation: a retry could duplicate a completed write. */
  private get writePolicy(): RetryPolicy {
    return { ...this.readPolicy, retries: 0, retryOnTimeout: false };
  }

  private get imagePolicy(): RetryPolicy {
    return {
      ...this.readPolicy,
      timeoutMs: this.config.imageTimeoutMs,
      retryOnTimeout: false,
      retryStatuses: IMAGE_RETRY_STATUS,
    };
  }

  /** Downloading an image the upstream already produced. */
  get downloadPolicy(): RetryPolicy {
    return this.readPolicy;
  }

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
    const response = await fetchWithRetry(
      `${this.config.newApiBaseUrl}/api/user/login`,
      () => ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      }),
      this.writePolicy,
    );
    const body = await this.parseJson<ApiEnvelope<LoginUser>>(response);
    if (!body.success) throw new Error(body.message || "用户名或密码错误");
    const cookie = this.sessionCookie(response);
    if (body.data?.require_2fa) return { kind: "2fa", sessionCookie: cookie };
    if (!body.data?.id || !body.data.username) throw new Error("RiverMoon login response is incomplete");
    return { kind: "success", user: body.data, sessionCookie: cookie };
  }

  async verifyTwoFactor(sessionCookie: string, code: string): Promise<LoginResult> {
    const response = await fetchWithRetry(
      `${this.config.newApiBaseUrl}/api/user/login/2fa`,
      () => ({
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({ code }),
      }),
      this.writePolicy,
    );
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
    const response = await fetchWithRetry(
      `${this.config.newApiBaseUrl}${path}`,
      () => ({
        ...init,
        headers: {
          cookie: sessionCookie,
          "New-Api-User": String(userId),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      }),
      init.method && init.method !== "GET" ? this.writePolicy : this.readPolicy,
    );
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
    channel: UpstreamChannel,
  ): Promise<void> {
    await this.sessionRequest<unknown>("/api/token/", sessionCookie, userId, {
      method: "POST",
      body: JSON.stringify({
        name: channel.tokenName,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: channel.models.join(","),
        allow_ips: "",
        group: channel.group,
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

  /**
   * Provision one model-limited token per configured channel and return the raw
   * keys by channel id. Adding a capability is a config change, not a code one.
   */
  async ensureChannelTokens(
    sessionCookie: string,
    userId: number,
  ): Promise<Record<string, string>> {
    let tokens = await this.listTokens(sessionCookie, userId);

    for (const channel of this.config.channels) {
      const existing = tokens.find(
        (token) => token.name === channel.tokenName && token.group === channel.group,
      );
      if (!existing) {
        await this.createToken(sessionCookie, userId, channel);
        tokens = await this.listTokens(sessionCookie, userId);
      }
    }

    const keys: Record<string, string> = {};
    for (const channel of this.config.channels) {
      const token = tokens.find(
        (candidate) => candidate.name === channel.tokenName && candidate.group === channel.group,
      );
      if (!token) throw new Error(`Unable to provision the RiverMoon ${channel.id} token`);
      keys[channel.id] = await this.tokenKey(sessionCookie, userId, token.id);
    }
    return keys;
  }

  private async imageRequest(
    path: string,
    apiKey: string,
    init: () => RequestInit,
  ): Promise<ImageResult> {
    const response = await fetchWithRetry(
      `${this.config.imageApiBaseUrl}${path}`,
      () => {
        const request = init();
        return {
          ...request,
          headers: {
            authorization: `Bearer ${apiKey}`,
            ...request.headers,
          },
        };
      },
      this.imagePolicy,
    );
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
    return this.imageRequest("/v1/images/generations", apiKey, () => ({
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
    }));
  }

  async editImage(
    apiKey: string,
    input: {
      prompt: string;
      images: string[];
      size: string;
      quality: string;
      outputFormat: string;
      n: number;
    },
  ): Promise<ImageResult> {
    const form = new FormData();
    form.set("model", "gpt-image-2");
    form.set("prompt", input.prompt);
    form.set("size", input.size);
    form.set("quality", input.quality);
    form.set("output_format", input.outputFormat);
    form.set("response_format", "b64_json");
    form.set("n", String(input.n));

    for (let index = 0; index < input.images.length; index += 1) {
      const image = await this.loadImage(input.images[index]);
      const field = input.images.length === 1 ? "image" : "image[]";
      form.append(
        field,
        new Blob([Buffer.from(image.bytes)], { type: image.mimeType }),
        `reference-${index + 1}.${image.extension}`,
      );
    }

    return this.imageRequest("/v1/images/edits", apiKey, () => ({ method: "POST", body: form }));
  }

  private videoUrl(path: string): string {
    return `${this.config.videoApiBaseUrl}${path}`;
  }

  /**
   * NewAPI rejects a task query made with a model-limited key on releases before
   * QuantumNous/new-api#5133, which is easy to mistake for a bad token.
   */
  private videoError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/no access to model/i.test(message)) {
      return new Error(
        `${message} — the RiverMoon video token is model-limited and this NewAPI release cannot read the model on a task query. Upgrade NewAPI (fix: QuantumNous/new-api#5133).`,
      );
    }
    return error instanceof Error ? error : new Error(message);
  }

  private normalizeVideoTask(body: Record<string, unknown>, fallbackId?: string): VideoTask {
    const taskId = String(body.task_id ?? body.id ?? fallbackId ?? "");
    if (!taskId) throw new Error("RiverMoon video API did not return a task id");

    const raw = String(body.status ?? "queued").toLowerCase();
    const status: VideoStatus =
      raw === "completed" || raw === "success" || raw === "succeeded"
        ? "succeeded"
        : raw === "failed" || raw === "error"
          ? "failed"
          : raw === "processing" || raw === "in_progress"
            ? "in_progress"
            : "queued";

    const error = body.error;
    return {
      taskId,
      status,
      url: typeof body.url === "string" ? body.url : undefined,
      format: typeof body.format === "string" ? body.format : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
      error:
        typeof error === "string"
          ? error
          : error && typeof error === "object"
            ? String((error as { message?: unknown }).message ?? JSON.stringify(error))
            : undefined,
    };
  }

  async createVideoTask(
    apiKey: string,
    input: {
      model: string;
      prompt: string;
      image?: string;
      duration?: number;
      size?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<VideoTask> {
    const body: Record<string, unknown> = { model: input.model, prompt: input.prompt };
    if (input.image) body.image = input.image;
    if (input.duration !== undefined) body.duration = input.duration;
    if (input.size && input.size !== "auto") body.size = input.size;
    if (input.metadata && Object.keys(input.metadata).length > 0) body.metadata = input.metadata;

    try {
      const response = await fetchWithRetry(
        this.videoUrl("/v1/video/generations"),
        () => ({
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        this.imagePolicy,
      );
      return this.normalizeVideoTask(await this.parseJson<Record<string, unknown>>(response));
    } catch (error) {
      throw this.videoError(error);
    }
  }

  async getVideoTask(apiKey: string, taskId: string): Promise<VideoTask> {
    try {
      const response = await fetchWithRetry(
        this.videoUrl(`/v1/video/generations/${encodeURIComponent(taskId)}`),
        () => ({ headers: { authorization: `Bearer ${apiKey}` } }),
        this.readPolicy,
      );
      return this.normalizeVideoTask(await this.parseJson<Record<string, unknown>>(response), taskId);
    } catch (error) {
      throw this.videoError(error);
    }
  }

  private async loadImage(value: string): Promise<{
    bytes: Uint8Array;
    mimeType: string;
    extension: string;
  }> {
    if (/^https?:\/\//i.test(value)) {
      const response = await fetchWithRetry(value, () => ({}), this.downloadPolicy);
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
