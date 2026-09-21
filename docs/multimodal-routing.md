# Multimodal routing guard

Jev is text-only. When a request contains image, audio, video, or file
attachments the gateway cannot inspect, it forwards the original request
untouched (`passthrough`, reason `multimodal_content`):

- No Jev call, no forced tool, no forced none, no synthetic direct response.
- Original attachment bytes, model selection, and credentials flow unchanged.
- Image URLs are never downloaded; image payloads are never sent to Jev.
- Reason is metadata-only (`x-jev-gateway-reason: multimodal_content`).

Coverage: Chat Completions content parts, Responses input items (including
nested tool-result images and file refs), Anthropic Messages blocks
(including nested tool-result images), Gemini parts (`inlineData`/`fileData`).

History is conservative: if any turn — including old turns — still carries
an image or opaque file reference, the request bypasses. The gateway does
not guess that an old image was already understood by the upstream model.
