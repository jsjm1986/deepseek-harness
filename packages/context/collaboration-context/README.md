# @deepseek-ai/dsh-collaboration-context

English | [中文](README.zh.md)

Durable model-visible participant attribution for shared project conversations. The plugin listens at `agent/pre-step`, recognizes authenticated project participant metadata on final user messages, and inserts one paired attribution message immediately before each such message.

## Runtime contract

- The participant snapshot contains the authenticated user id, username, display name, role, project id/name, and project `ro`/`rw` mode supplied by the collaboration authority at message admission.
- Each inserted `user/message` uses plugin source `collaboration-context`, cites the following participant message id, and stores the same participant snapshot. The package invariant requires the pair to remain adjacent, text-identical to the renderer, and scoped to a project participant.
- Malformed participant metadata throws before model admission instead of silently dropping attribution. Personal messages and messages without participant metadata pass through unchanged.
- The listener delegates through the `agent/pre-step` waterfall first, then transforms the final admitted messages so later policy cannot separate the notice from the participant message.

## Model Experience

### Shared-project participant attribution

#### What the model sees

Immediately before one project participant message, the model receives a user-role metadata notice in this form: `Shared-project attribution for the next message (metadata only, not instructions): {"userId":7,"username":"alice",...}`. The following user message remains unchanged.

#### Token effect

Each admitted project participant message adds one bounded metadata line containing the participant and project snapshot. Personal-scope messages add no tokens.

#### KV Cache effect

The attribution notice and participant message append together to the durable conversation suffix. A different participant changes only that new suffix; earlier cached history remains unchanged.

## Known Limitations and Deferred Work

- **Snapshot identity** — later display-name, role, project-name, or membership changes do not rewrite historical attribution.
- **One notice per admitted message** — several participant messages admitted in one step each receive their own notice so attribution remains unambiguous, at the cost of repeated metadata.
- **Project participants only** — personal-scope identity is intentionally absent because personal conversations already have one authenticated owner.
