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

## Prompts

- Preserve the user's exact subject, composition, text, dimensions, and exclusions.
- For edits, state what must change and what must remain unchanged.
- Pass reference images in the same order the user supplied them.
- Keep exact in-image text in quotation marks in the prompt.

## Results

- Present returned images directly.
- Mention the selected RiverMoon tier briefly.
- When a tool returns an error, relay the actionable error without exposing tokens, cookies, or internal credentials.
