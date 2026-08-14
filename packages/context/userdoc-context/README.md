# @deepseek-ai/dsh-userdoc-context

English | [中文](README.zh.md)

Prompt-side context for `ctx.userDocs`. The plugin validates the uploaded document ids before a prompt is admitted, chooses an exact inline-text or path-only representation, and records the host-admitted snapshot in the Session log.

## Public API

`prepareUserDocAttachments()` resolves a whole document batch before the Host calls `followup()` or `steer()`. It enforces `UserDocLimits.maxFilesPerMessage` and `maxMessageBytes`; a file at or below `maxInlineTextBytes` is read once and inlined only when its bytes are strict UTF-8. Other files remain path references for the agent's existing filesystem tools. `renderUserDocAttachment()` renders the frozen representation as a text block.

After the exact `user/message` event is appended, the plugin adds one `userdoc/attached` event per document. Each event carries the cited message id, document index, metadata, and the representation that appeared in the user message, so replay can verify that model-visible document context was admitted by the Host rather than supplied by the browser.

## Model Experience

### Admitted document context

#### What the model sees

Each uploaded document becomes one text block in the user message. Small strict-UTF-8 files include their contents; larger or binary files name the ordinary host path that the agent's filesystem tools can read.

##### Inline representation

```markdown
Uploaded document "notes.txt" at "/workspace/uploads/2026-08-14/notes.txt"; contents inlined verbatim:
<file contents>
```

##### Path representation

```markdown
Uploaded document "report.pdf" is available at "/workspace/uploads/2026-08-14/report.pdf". Use the filesystem tools to read it.
```

#### Token effect

Inline documents consume the UTF-8 bytes rendered into the user message, subject to `maxInlineTextBytes` and the aggregate message limit. Path-only documents add a short reference and leave format-specific reading to later tool calls.

#### KV Cache effect

The rendered document text is part of the append-only user-message suffix. Reusing a session preserves earlier prompt history; a new upload changes only the new message suffix, while a path-only document does not load file bytes into the model request.

## Known Limitations and Deferred Work

- **No document parser** — the plugin does not extract PDF, spreadsheet, image, or archive text. Binary and undecodable files remain path references, and the agent's tools decide how to inspect them.
- **Snapshot at admission** — inline bytes and reference metadata are frozen before the prompt enters the Session; changes to the ordinary file after admission do not rewrite that historical message.
- **No historical browser library** — the browser rail owns the current draft, while durable files remain in the workspace and are listed or removed through the Host document service.
