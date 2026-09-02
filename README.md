# RiverMoon Codex Image Plugin

This repository contains the first RiverMoon image plugin for Codex and its OAuth-protected MCP gateway.

## Install

Run this single command, then start a new Codex session:

```bash
codex plugin marketplace add https://rivermoon7.com/codex-marketplace/rivermoon/ && codex plugin add rivermoon@rivermoon
```

This primary source is hosted by RiverMoon and does not require access to GitHub. The repository at
`MoonFlower-King/rivermoon-codex-plugin` remains available as a public mirror.

Codex opens the RiverMoon authorization page when authentication is needed. Sign in with an existing
RiverMoon account, or create one at [rivermoon7.com/register](https://rivermoon7.com/register).

## Features

- GPT Image 2 generation and editing
- `standard` tier routed through the NewAPI `default` group
- `pro` tier routed through the NewAPI `4k` group
- Browser OAuth login backed by existing RiverMoon accounts
- Automatic creation of two user-owned, `gpt-image-2`-limited API tokens
- Encrypted upstream credentials and hashed OAuth access tokens
- Timeouts and bounded retries on every upstream call
- Short-lived download links for images too large to inline

## Usage

Ask Codex to generate or edit an image normally. The plugin defaults to `standard`; requests for
professional, final, highest-quality, or 4K output use `pro`.

- `standard` uses the NewAPI `default` group.
- `pro` uses the NewAPI `4k` group and defaults to high quality.
- `size` accepts `auto` or `WIDTHxHEIGHT` with each side between 256 and 4096 pixels; anything else
  is rejected before the request reaches RiverMoon.
- `n` (1-4) works for both generation and editing.
- `account_status` reports the remaining balance in USD, plus an estimated image count when
  `STANDARD_IMAGE_COST_USD` and `PRO_IMAGE_COST_USD` are set.

### Large images

An image above `MAX_INLINE_IMAGE_BYTES` is never dropped. The gateway returns the upstream URL when
there is one, otherwise it caches the file and returns a `/codex-files/<id>` link that expires
after `ARTIFACT_TTL_SECONDS`. The cache is bounded by `ARTIFACT_MAX_TOTAL_BYTES` and pruned on every
write, because the host runs on a single small system disk.

### Timeouts and retries

Account and token calls time out after `UPSTREAM_TIMEOUT_MS`; image calls after `IMAGE_TIMEOUT_MS`.
Transient failures retry up to `UPSTREAM_RETRIES` times with exponential backoff, honoring
`Retry-After`. Logins and token creation are not retried, and image calls only retry statuses that
mean no image was billed (429, 502, 503, 504).

The plugin directs Codex to use RiverMoon for image work whenever its tools are available. Codex's
built-in image capability cannot currently be physically removed by a third-party plugin.

## Layout

- `plugins/rivermoon`: Codex plugin bundle
- `.agents/plugins/marketplace.json`: marketplace catalog
- `gateway`: OAuth and MCP service

## Local gateway development

```bash
cd gateway
cp .env.example .env
npm install
npm run dev
```

Set `ENCRYPTION_KEY_BASE64` to a random 32-byte base64 value before starting the service.

## Production deployment

1. Copy `gateway/.env.example` to `gateway/.env` and set `ENCRYPTION_KEY_BASE64`.
2. Run `docker compose up -d --build` from `gateway/`.
3. Add `gateway/deploy/nginx-rivermoon-codex.conf` to the existing HTTPS server block. It now also
   proxies `/codex-files/` for large-image downloads.
4. Validate Nginx configuration and reload it.
5. Confirm `https://rivermoon7.com/.well-known/oauth-protected-resource` and `/healthz` respond correctly.

The gateway forwards passwords only to the local NewAPI login endpoint and does not persist them. It stores RiverMoon session cookies and generated image API keys encrypted with AES-256-GCM.

## Authentication and privacy

RiverMoon account passwords are sent only to the local NewAPI login endpoint for the current login
attempt and are never stored by the gateway. Session cookies and generated NewAPI keys are encrypted
with AES-256-GCM. OAuth access and refresh tokens are stored only as hashes.
