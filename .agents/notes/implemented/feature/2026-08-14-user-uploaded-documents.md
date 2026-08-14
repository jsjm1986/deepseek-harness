# Agent Note: user-uploaded documents as real files

Status: implemented

English | [中文](2026-08-14-user-uploaded-documents.zh.md)

## Problem

A person using the harness could only reference documents that already existed on the server. There was no way to bring a file of their own into a session. The existing intake path — `ctx.attachments` — cannot serve this: it is image-only end to end (`ImageMediaType` is a four-member union, every method is `validateImage`/`saveImage`/`readImage`), and it stores content-addressed private blobs under `<DSH_HOME>/attachments/v1/objects/<aa>/<sha>`. Those objects are invisible to `read`, `grep`, and `glob`, so even after a successful upload the agent would have no way to open the document.

Widening the image seam would have meant giving one service two incompatible storage semantics: deduplicated opaque objects for images, named user-visible files for documents.

## Decision

A second capability seam, beside the attachment seam rather than inside it.

`ctx.userDocs` (`packages/attachment/userdoc`, abstract `UserDocStore`) stores an upload as an **ordinary named file** and publishes a `UserDocRef` carrying its real absolute path. The path is the mechanism, not an implementation leak: an uploaded document becomes reachable by the agent's existing filesystem and shell tools, so no retrieval channel of its own has to exist. The deployment is responsible for rooting uploads inside a directory the tool authorization policy already grants — under the multi-user gateway that is the user's home directory, which `gateway/src/projects.ts` `effectiveGrants()` already emits as `rw`, so publishing the path grants nothing the session did not already hold.

`packages/attachment/userdoc-local` (`LocalUserDocStore`) is the local provider: uploads land at `<uploadRoot>/YYYY-MM-DD/<name>`, defaulting to `<home>/uploads`.

Four properties are deliberate:

**No format allowlist, and no server-side parsing.** `mediaType` is derived from the stored name for presentation only; nothing admits, parses, dispatches on, or verifies it. A harness accepts what a person uploads and lets the agent decide what the file is. Text extraction, PDF parsing, thumbnailing, and OCR are all outside the seam.

**Writes are two explicit steps.** `resolveTarget` sanitizes the untrusted client name, resolves the target inside the upload root, and returns the exact path; `save` streams bytes to that path. Naming and containment policy therefore has one auditable home, and `save` never defaults a target of its own — the `dsh-shell` request/spec split applied to storage.

**Every read path takes the store-scoped `docId`, never a `UserDocRef`.** A reference carries an absolute path, and a caller's copy of one is untrusted input. `stat`, `read`, `openRead`, and `remove` re-derive the path from the identifier and re-prove containment, so a tampered path cannot name a file outside the upload root.

**Limits are enforced against received bytes.** `save` counts what it actually reads and aborts mid-stream past `maxFileBytes`, removing the partial file. A declared `content-length` is never trusted, so an oversized upload cannot fill the disk by streaming past its declaration.

Storage is not content-addressed: two uploads of identical bytes are two files with two identifiers, and deleting one cannot affect the other — what a person expects of files in their own directory.

### Host transport and prompt admission

`packages/host/userdoc-http` registers a streaming `/api/documents` subtree through the Host Connection. The existing Host/Origin trust fence runs before the subtree handler; the upload body then stays out of the buffered JSON bridge. `POST` requires `x-dsh-document-upload: 1`, streams the raw body into `UserDocStore`, and rejects an oversized declared length before reading it. `GET` lists references and limits, `GET`/`HEAD` streams one content body with `nosniff` and attachment disposition, and `DELETE` is idempotent. Error responses expose stable document error codes without paths or bytes.

The prompt API accepts document ids alongside text and images. `prepareUserDocAttachments` resolves every id before any prompt is committed, enforces the per-message count and aggregate-byte limits, and freezes one representation per document: strict UTF-8 content at or below `maxInlineTextBytes` is inlined, while other files are represented by their stored path. The host renders both forms as text blocks and copies the host-admitted snapshots into the user message source; client-supplied paths or inline text are never trusted. The web bundle composes the local store, prompt-context plugin, and streaming HTTP consumer together.

The `userdoc-context` plugin listens after the exact `user/message` event is appended and records one `userdoc/attached` event per document, including the message id, order, metadata, and frozen representation. This keeps every document detail that reaches a model reconstructable from the session log without adding a new core `ContentBlock` kind.

### Browser intake

The conversation controller owns browser-only draft identities and metadata while the Host owns durable ids. Paste and drag-and-drop send image MIME types through the existing image path and every other file through the streaming document client. The input bar shows a document rail with upload progress, ready/failed states, retry, and removal. Submission waits for uploads to become ready; a failed prompt restores the document ids and draft text, while a successful prompt releases browser metadata but leaves the durable files in place. Removing a draft aborts an in-flight upload and best-effort deletes its durable file, and service teardown aborts all remaining uploads.

### Containment

`.part` staging files are created with `O_EXCL`, which never follows an existing symlink, so a pre-planted link cannot redirect a write outside the root. Only a completed, synced file is renamed into place. Listing skips non-regular entries rather than following them, so a symlink planted inside the root cannot publish a reference to a file outside it. Name sanitization strips both separator styles by hand (a POSIX host treats `\` as an ordinary filename character, so `basename` alone would keep a Windows client's full local path), rejects `..` and all-dot names, strips control characters, and truncates to 255 **bytes** rather than code units — the limit filesystems enforce is bytes, and a Chinese document title reaches it at a quarter the character count.

## Alternatives considered

**Widen `ctx.attachments` to accept documents.** Rejected: it would put two incompatible storage semantics behind one service. Content addressing is right for images (dedup, immutability, digest verification on every read) and wrong for documents (a person's `年报.pdf` is not interchangeable with an identical copy, and must be named, listable, and deletable on its own). Every method on that seam is also image-specific, so the widening would have been a rewrite wearing the old name.

**Store documents as content-addressed private blobs, like images.** Rejected as the primary storage: the blobs are invisible to `read`/`grep`/`glob`, which defeats the purpose. Serving them would have required a new model-facing retrieval tool — more surface, and a second way to read a file that the agent already knows how to read.

**A new `ContentBlock` kind for documents.** Deferred. `packages/llm/llm/src/types.ts` states that a new core block must land with adapter, UI, and compaction support simultaneously; that is a larger change than this seam, and a `text` block carrying the path or the inlined content already reaches the model correctly.

**Trust the client's `content-type` header for `mediaType`.** Rejected: it is unverifiable at this boundary and nothing in the seam acts on the value, so trusting it would add an input to defend for no behavior gained. Deriving from the stored name also keeps `save` and `list` reporting the same type, which a client-declared value would not survive.

**One `userdoc/` package group.** Rejected in favor of the existing `attachment/` group: both packages are user-supplied files reaching a model, and `tsconfig.base.json` maps groups through two wildcard lists that a new group would have to be threaded into for no gain. Keeping them adjacent also keeps the contrast between the two seams visible in one directory.

## Consequences

The harness gains a second file-storage seam, and which one a caller wants is now a real decision: images go to `ctx.attachments` because a provider needs their bytes inline, everything else to `ctx.userDocs` because an agent reads it as a file. Two seams cost more than one, and a future caller could reach for the wrong one; the READMEs state the discriminator on both sides.

Publishing a real path is the trade. It buys every format for free — no parser, no allowlist, no per-type code path, and the agent's existing tools do the reading — and it costs the guarantee that a stored object is unreachable except through the seam. The upload root must therefore sit inside a directory the tool authorization policy already grants, which is a deployment obligation this package can state but not enforce. Under the multi-user gateway that holds today: `effectiveGrants()` already emits the user's home as `rw`.

Storage is not content-addressed, so identical uploads are separate files and there is no dedup. That is what a person expects of files in their own directory, and it means deleting one upload can never affect another. It also means the seam has no retention story: uploads accumulate until removed, and disk is a shared resource no per-user store can see, so quota belongs to the gateway.

Nothing verifies a document on read. A stored file is ordinary, so anything with filesystem access — including the agent itself — may have changed it since upload, and `bytes` is the length recorded at upload time. Consumers that need certainty must re-read rather than trust a reference.

## Testing

The storage seam and local provider retain their 97 unit tests at the repository's per-file 100% coverage bar. The HTTP consumer, prompt admission, agent-event durability, Connection dispatch, and browser composer behavior add focused tests, and the headless keyless snapshot exercises the assembled user-document prompt path. The containment suite covers traversal via `..`, absolute and Windows-separator identifiers, all-dot names, a symlink planted at the target, a symlinked entry during listing, mid-stream limit overrun leaving no partial file, and identifier tampering. Failure paths that require a filesystem error other than absence are covered through a mocked `node:fs/promises`.

## Operational limits

The `/api` JSON envelope still buffers request bodies and therefore does not carry uploads; the streaming subtree is deliberately separate. The store has no per-user disk quota or retention policy, so deployments must provide capacity and cleanup policy outside this seam. The browser exposes the current draft rail rather than a second historical document viewer; durable files remain ordinary workspace files and can be inspected through the agent's existing filesystem tools.
