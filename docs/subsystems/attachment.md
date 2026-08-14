# Durable Image Attachments

English | [中文](attachment.zh.md)

The attachment seam separates binary image ownership from the session log. A producer gives validated encoded bytes to [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam); the service publishes an immutable content-addressed reference only after the object is durable. Session events and model-visible `ImageBlock`s contain that reference and metadata, never a browser object URL, host temporary path, provider URL, or base64 payload.

Unsent browser drafts may stay in memory and native clients may stage them in operating-system temporary storage. Once the host accepts a user message, its images move below `<DSH_HOME>/attachments/v1` before the user event is appended. Structured model image output follows the same persist-before-event rule.

Source: [`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## Identity and verified metadata

`AttachmentId` is a branded opaque string. The local backend currently emits `sha256:<digest>`, but consumers must neither parse that representation nor derive a filesystem path from it.

```ts type-equiv
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

```ts type-equiv
/** Durable, serializable metadata for one immutable image object. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}
```

```ts type-equiv
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  mediaTypes: readonly ImageMediaType[]
}
```

The reference records intrinsic dimensions and encoded length so clients can lay out history without decoding first, while every authoritative read still re-checks digest, media signature, dimensions, and metadata against the object.

## Commit and verified-read payloads

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
```

`saveImage()` validates bytes and atomically commits one object before returning its reference. `validateImage()` runs the same admission checks without persisting anything; batch callers validate every member through it before saving any member, so validation rejection leaves no partial objects behind. `readImage()` accepts a reference from an authorized session path and returns bytes only after integrity verification. The service is deliberately retention-neutral: resumed and forked sessions may share objects, so reference-aware garbage collection is deferred rather than tied to any one session's deletion.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxattachments--attachmentstore-abstract-seam"></a>

### `ctx.attachments` — `AttachmentStore` (abstract seam)

Immutable binary attachment service. Implementations validate bytes before publishing a reference.

```ts cordis-catalog
/**
 * Validate one image without persisting it.
 * Batch callers validate every member before saving any member.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns completion after the encoded raster has been fully decoded.
 */
abstract validateImage(input: SaveImageAttachment): Promise<void>

/**
 * Validate and durably commit one image before its owning session event is appended.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns a durable content-addressed reference.
 */
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

/**
 * Read one image and verify that bytes still match the recorded reference.
 * @param ref - durable reference from the session log.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified bytes and canonical reference.
 * @throws the signal reason when aborted, or a storage error when verification fails.
 */
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
```

Source: [`packages/attachment/attachment/src/index.ts:29`](../../packages/attachment/attachment/src/index.ts)

<a id="ctxuserdocs--userdocstore-abstract-seam"></a>

### `ctx.userDocs` — `UserDocStore` (abstract seam)

Storage for documents a user uploads into their own workspace.

The stored form is an ordinary named file, not an opaque object: a document lands at a real path the agent's filesystem and shell tools can read, which is what lets one uploaded file serve every format without this seam knowing any of them. Nothing here inspects, parses, or whitelists content — `mediaType` is recorded and never acted upon, so an unrecognized format is stored exactly like a recognized one and the agent decides how to read it.

Writes are two explicit steps. `resolveTarget` sanitizes the untrusted client name and computes the path; `save` streams bytes to that path. Naming policy therefore has one auditable home, and `save` never defaults a target of its own.

```ts cordis-catalog
/**
 * Resolve one untrusted client file name to the absolute path a `save` will
 * create. Implementations sanitize the name, keep the result inside the
 * upload root, and pick a leaf that no existing entry holds.
 * @param input - client-supplied name, treated as untrusted text.
 * @returns the resolved write target.
 * @throws UserDocError when no acceptable free name can be derived from the input.
 */
abstract resolveTarget(input: ResolveUserDocTarget): Promise<UserDocTarget>

/**
 * Stream one document to a resolved target and publish its reference.
 *
 * Implementations enforce `maxFileBytes` while streaming, so an oversized
 * upload is cut off rather than buffered, and leave no partial file behind on
 * failure or cancellation. The recorded `mediaType` is derived from the stored
 * name, never taken from a client header: a declared type is unverifiable
 * here, and nothing in this seam acts on the value anyway.
 * @param target - a target from this store's own `resolveTarget`.
 * @param body - the upload byte stream.
 * @param signal - optional cancellation for the streaming write.
 * @returns the durable reference to the stored document.
 * @throws UserDocError when the stream exceeds `maxFileBytes` or the write fails.
 */
abstract save( target: UserDocTarget, body: ReadableStream<Uint8Array>, signal?: AbortSignal, ): Promise<UserDocRef>

/**
 * List every stored document, newest modification first.
 * @param signal - optional cancellation for the directory scan.
 * @returns references to all stored documents; empty before the first upload.
 */
abstract list(signal?: AbortSignal): Promise<UserDocRef[]>

/**
 * Resolve one identifier to its current reference.
 *
 * Every read path takes this identifier rather than a `UserDocRef`, because a
 * reference carries an absolute path and a caller's copy of one is untrusted
 * input. Implementations re-derive the path from the identifier and re-prove
 * containment, so a tampered path cannot name a file outside the upload root.
 * @param docId - identifier from a previous `save` or `list`.
 * @param signal - optional cancellation for the filesystem probe.
 * @returns the current reference.
 * @throws UserDocError when the identifier is malformed, escapes the upload root, or names no file.
 */
abstract stat(docId: UserDocId, signal?: AbortSignal): Promise<UserDocRef>

/**
 * Read one stored document in full.
 * @param docId - identifier from a previous `save` or `list`.
 * @param signal - optional cancellation for the read.
 * @returns the bytes and the reference they were read through.
 * @throws the signal reason when aborted, or a UserDocError when the identifier does not resolve to a file.
 */
abstract read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc>

/**
 * Open one stored document as a byte stream, for a download response that must
 * not hold the whole file in memory.
 * @param docId - identifier from a previous `save` or `list`.
 * @returns the reference and its byte stream.
 * @throws UserDocError when the identifier does not resolve to a file.
 */
abstract openRead(docId: UserDocId): Promise<{ ref: UserDocRef; body: ReadableStream<Uint8Array> }>

/**
 * Delete one stored document. Deleting an already-absent document succeeds, so
 * a client retrying a delete it already completed is not an error.
 * @param docId - identifier from a previous `save` or `list`.
 * @param signal - optional cancellation.
 * @returns after the entry is gone.
 * @throws UserDocError when the identifier is malformed or escapes the upload
 * root, or the deletion fails for any reason other than absence.
 */
abstract remove(docId: UserDocId, signal?: AbortSignal): Promise<void>
```

Source: [`packages/attachment/userdoc/src/index.ts:62`](../../packages/attachment/userdoc/src/index.ts)
<!-- END GENERATED cordis-surface -->
