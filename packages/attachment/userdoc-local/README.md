# @deepseek-ai/dsh-userdoc-local

English | [中文](README.zh.md)

Local `userDocs` backend that stores uploads as ordinary files below one configured root, `<home>/uploads` by default. A save lands at `<root>/<YYYY-MM-DD>/<name>`, so a day's uploads group together and the path a user reads in the UI is the path the agent reads with `read` or `bash`.

Writes are two steps. `resolveTarget` sanitizes the untrusted client name — both separator styles stripped by hand, control characters removed, byte-truncated to 255, dot-only names refused — then picks the first free leaf, suffixing ` (2)` before the extension and failing with `DOC_NAME_EXHAUSTED` past a thousand collisions. `save` streams to a sibling `.part` file opened `O_CREAT | O_EXCL`, which never follows a pre-planted symlink, counts bytes as they arrive so an oversized upload is cut off mid-flight rather than buffered, fsyncs, and renames. Every failure path removes the partial file. Containment is proved by path segments rather than string prefix, once when the target resolves and again before the write.

Reads take the store-scoped `docId` — the root-relative path with forward slashes — never a caller's copy of a `UserDocRef.path`. Each read re-derives the path from that identifier and re-proves containment, so a tampered reference cannot name a file outside the root. `list` skips symlinks rather than following them and hides in-progress `.part` files; an absent root lists empty. `openRead` hands the download route a stream whose descriptor closes on cancellation. `remove` treats an already-absent file as success.

`mediaType` is derived from the stored file extension, and an unrecognized extension records `application/octet-stream`. It is presentation metadata: nothing here parses content or refuses an unknown format.

## Model Experience

Indirectly, through the host prompt-assembly consumer that turns a stored reference into inlined text or a path the agent reads with its ordinary tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No per-user disk quota** — `maxFileBytes` bounds one upload and `maxMessageBytes` one message, but nothing bounds a root's total size, so a deployment that shares a disk between users needs a quota above this package.
- **Retention is manual** — stored documents live until a user deletes them; there is no expiry or garbage collection.
- **`list` walks the tree on every call** — there is no index, so a root holding many thousands of files pays a full scan per listing.
- **Day grouping uses UTC** — a user uploading near local midnight sees the file under the UTC date, which may not be their calendar day.
