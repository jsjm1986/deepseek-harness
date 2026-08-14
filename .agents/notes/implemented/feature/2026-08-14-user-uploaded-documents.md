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

97 unit tests across the two packages, at the repository's per-file 100% coverage bar. Each containment rule has a rejection case: traversal via `..`, absolute and Windows-separator identifiers, all-dot names, a symlink planted at the target, a symlinked entry during listing, mid-stream limit overrun leaving no partial file, and identifier tampering. Failure paths that require a filesystem error other than absence are covered through a mocked `node:fs/promises`.

## Deferred

The seam and its local provider ship here. Not yet built: the streaming HTTP upload/download/list routes, the `userdoc/attached` session event and prompt-assembly split between inlined text and path-only reference, the composer intake that stops filtering non-images out, the standalone document view, and per-user disk quota in the gateway. The plan for those lives with this change's author; each is independently reviewable.

The `/api` POST envelope cannot carry uploads: `packages/client/connection/src/http-bridge.ts` buffers the whole body in memory and `toFetchHandler` requires `application/json`. The upload route must be a separate streaming path, following the `DownloadsApi` precedent for host-only non-envelope channels.
