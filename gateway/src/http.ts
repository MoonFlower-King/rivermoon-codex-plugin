export interface RetryPolicy {
  timeoutMs: number;
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOnTimeout: boolean;
  /** Defaults to the transient set: 408, 425, 429, 500, 502, 503, 504. */
  retryStatuses?: ReadonlySet<number>;
}

export class UpstreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`RiverMoon upstream did not respond within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "UpstreamTimeoutError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const jitter = 1 + Math.random() * 0.25;
  return Math.min(Math.round(exponential * jitter), policy.maxDelayMs);
}

function retryAfterDelay(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * Perform a fetch that always carries a timeout and retries transient upstream
 * failures. `init` is a factory so every attempt gets a fresh body: a FormData
 * or stream body cannot be replayed once the first attempt consumed it.
 */
export async function fetchWithRetry(
  url: string,
  init: () => RequestInit,
  policy: RetryPolicy,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { ...init(), signal: AbortSignal.timeout(policy.timeoutMs) });
    } catch (error) {
      const timedOut = isTimeout(error);
      lastError = timedOut ? new UpstreamTimeoutError(policy.timeoutMs) : error;
      if (attempt === policy.retries || (timedOut && !policy.retryOnTimeout)) throw lastError;
      await sleep(backoffDelay(attempt, policy));
      continue;
    }

    const retryable = policy.retryStatuses ?? RETRYABLE_STATUS;
    if (!retryable.has(response.status) || attempt === policy.retries) return response;

    const wait = Math.min(retryAfterDelay(response) ?? backoffDelay(attempt, policy), policy.maxDelayMs);
    await response.body?.cancel().catch(() => undefined);
    await sleep(wait);
  }

  throw lastError ?? new Error("RiverMoon upstream request failed");
}
