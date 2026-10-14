import dns from "node:dns";
import https from "node:https";
import net from "node:net";

/** Address ranges a user-supplied URL must never reach (loopback, private, link-local, metadata, ...). */
const blockedRanges = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedRanges.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedRanges.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blockedRanges.check(address, "ipv4");
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return !blockedRanges.check(address, "ipv6");
  }
  return false;
}

/**
 * DNS lookup that refuses non-public addresses. It runs at connect time, so a hostname
 * cannot pass validation and then rebind to an internal address.
 */
const publicOnlyLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((entry) => !isPublicAddress(entry.address));
    if (list.length === 0 || blocked) {
      return callback(new Error("Reference image host resolves to a non-public address"), "", 0);
    }
    if ((options as dns.LookupOptions).all) return callback(null, list as never, 0);
    callback(null, list[0].address, list[0].family);
  });
};

export interface RemoteFile {
  bytes: Uint8Array;
  contentType: string | undefined;
}

export interface RemoteFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
}

/** Download a user-supplied HTTPS URL with SSRF protection, a timeout and a size cap. */
export async function fetchPublicHttps(rawUrl: string, options: RemoteFetchOptions): Promise<RemoteFile> {
  let url = new URL(rawUrl);
  const maxRedirects = options.maxRedirects ?? 3;
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "https:") throw new Error("Reference image URLs must use HTTPS");
    if (url.username || url.password) throw new Error("Reference image URLs must not contain credentials");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(hostname) && !isPublicAddress(hostname)) {
      throw new Error("Reference image host resolves to a non-public address");
    }
    const result = await httpsGetOnce(url, options);
    if ("redirect" in result) {
      if (hop >= maxRedirects) throw new Error("Too many redirects while downloading reference image");
      url = new URL(result.redirect, url);
      continue;
    }
    return result;
  }
}

function httpsGetOnce(
  url: URL,
  options: RemoteFetchOptions,
): Promise<RemoteFile | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: publicOnlyLookup, timeout: options.timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: response.headers.location });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Unable to download reference image (${status})`));
        return;
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > options.maxBytes) {
        response.destroy();
        reject(new Error(`Reference image exceeds the ${options.maxBytes} byte limit`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > options.maxBytes) {
          response.destroy();
          reject(new Error(`Reference image exceeds the ${options.maxBytes} byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({ bytes: new Uint8Array(Buffer.concat(chunks)), contentType: response.headers["content-type"] });
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Timed out downloading reference image")));
    request.on("error", reject);
  });
}

/** Read a fetch() body without buffering more than maxBytes. */
export async function readBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Response exceeds the ${maxBytes} byte limit`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
