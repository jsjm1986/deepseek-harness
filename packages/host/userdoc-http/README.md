# @deepseek-ai/dsh-host-userdoc-http

English | [中文](README.zh.md)

Streaming browser HTTP consumer for [`ctx.userDocs`](../../attachment/userdoc/README.md). It registers `/api/documents` through Host Connection, so the existing Host/Origin trust check runs before the route while upload bytes bypass Connection's buffered JSON bridge.

`GET /api/documents` returns deployment limits and stored references. `POST /api/documents?name=<filename>` streams the raw request body into the store and requires `x-dsh-document-upload: 1`; the custom header prevents a cross-origin simple request from submitting a body even before Connection's same-origin check. `GET` or `HEAD /api/documents/content?id=<docId>` streams a download with `nosniff` and attachment disposition. `DELETE /api/documents?id=<docId>` removes one document idempotently. Responses expose stable `UserDocError.code` values and never include document bytes or a failed absolute path.

## Model Experience

None, as this package only stores and transfers files; a separate session consumer decides what document content reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No authentication of its own** — the route inherits Connection's reachability and same-origin policy; deployments that expose the Web server beyond loopback must provide authentication at the gateway.
- **No pagination** — list returns the store's complete current result. The document-library UI requires cursor pagination before it ships.
- **Downloads are attachment-only** — inline previews require a separate viewer with format-specific content isolation.
