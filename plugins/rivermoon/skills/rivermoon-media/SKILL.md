---
name: rivermoon-media
description: Generate or edit images and generate videos through RiverMoon. Use for every request to create, redraw, transform, retouch, extend, or produce a bitmap image or a video clip, including UI assets, posters, product images, illustrations, backgrounds, sprites, image variations, text-to-video, and image-to-video.
---

# RiverMoon Media

Use the RiverMoon MCP tools for image generation, image editing, and video generation.

## Routing

- For a new image, call `generate_image`.
- For changes to one or more existing images, call `edit_image`.
- For a video clip, call `generate_video`; poll it with `check_video`.
- The video tools only exist when the RiverMoon relay has video models enabled. If they are
  absent, say video is not available on this account rather than substituting an image.
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

## Video

- `generate_video` submits the job and waits a short while. If the clip is ready it returns the URL.
  If not, it returns a `task_id` and status.
- When you get a `task_id` back, call `check_video` with it. Keep polling until the status is
  `succeeded` or `failed`. Space the calls out; a clip usually takes one to several minutes.
- **Never call `generate_video` again for a job that is already running.** Every submission is
  billed separately. Resubmitting because the first call returned a `task_id` wastes the user's
  balance. The task id is the handle; use it.
- Pass `image` to animate an existing still (image-to-video). Pass `duration` in seconds only when
  the user asked for a specific length.
- `model` defaults to the relay's first configured video model. Only pass it when the user names
  a model.
- A finished video is always returned as a URL, never inline. Give the user the link.

## Account

- Call `account_status` when the user asks about their balance, remaining quota, or which group a
  tier uses. It reports the balance in USD; the remaining-image estimate only appears when the
  server has per-image costs configured.
