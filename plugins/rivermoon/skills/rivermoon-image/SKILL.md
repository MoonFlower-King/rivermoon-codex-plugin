---
name: rivermoon-image
description: Generate or edit images through RiverMoon GPT Image 2. Use for every request to create, redraw, transform, retouch, extend, or produce a bitmap image, including UI assets, posters, product images, illustrations, backgrounds, sprites, and image variations.
---

# RiverMoon Image

Use the RiverMoon MCP tools for image generation and editing.

## Routing

- For a new image, call `generate_image`.
- For changes to one or more existing images, call `edit_image`.
- Do not invoke Codex's built-in image generation skill or native image-generation tool when RiverMoon tools are available.
- If RiverMoon authentication is required, ask the user to complete the browser login and then retry the same tool call.
- Do not claim that an image was generated unless the MCP tool returned image content.

## Quality tier

- Use `standard` by default and for drafts, previews, routine assets, and cost-sensitive work.
- Use `pro` when the user asks for professional quality, highest quality, fine detail, a final deliverable, 4K, or explicitly requests the premium group.
- If the user explicitly names a tier, preserve it.
- For `pro`, prefer `quality: high` unless the user requests another supported quality.

## Size and count

- `size` accepts `auto` or `WIDTHxHEIGHT` with each side between 256 and 4096 pixels, for example
  `1024x1024`, `1024x1536`, `1536x1024`, or `2048x2048`. Any other value is rejected before the
  request reaches RiverMoon.
- Leave `size` at `auto` unless the user asked for specific dimensions or an aspect ratio.
- `n` (1-4) works for both `generate_image` and `edit_image`. Ask for one image unless the user
  wants variations, since every image is billed separately.

## Prompts

- Preserve the user's exact subject, composition, text, dimensions, and exclusions.
- For edits, state what must change and what must remain unchanged.
- Pass reference images in the same order the user supplied them.
- Keep exact in-image text in quotation marks in the prompt.

## Results

- Present returned images directly.
- Mention the selected RiverMoon tier briefly.
- An image above the inline size limit comes back as a download link instead of image content.
  Give the user that link as-is and say it expires; do not claim the image failed. If the user needs
  it inline, retry with a smaller `size`.
- When a tool returns an error, relay the actionable error without exposing tokens, cookies, or internal credentials.
- A timeout or upstream error is already retried by the gateway. Do not immediately retry the same
  call yourself; report the error and let the user decide.

## Account

- Call `account_status` when the user asks about their balance, remaining quota, or which group a
  tier uses. It reports the balance in USD; the remaining-image estimate only appears when the
  server has per-image costs configured.
