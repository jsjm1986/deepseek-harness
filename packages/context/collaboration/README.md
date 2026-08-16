# @deepseek-ai/dsh-collaboration

English | [中文](README.zh.md)

Service Definition for authenticated [project collaboration](../../../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md). Consumers capture one request-bound authority instead of reading mutable account state from a process-global service.

## Runtime contract

- `capture()` returns the authenticated participant, assertion expiry, provider lifetime signal, session authorization, batch readability filtering, and atomic approval/question claiming for the current request.
- `authorize()` resolves every descendant through its root conversation and returns the root-inherited project, visibility, creator, and `ro`/`rw` access facts.
- `withSessionCreation()` carries a project root conversation's `project` or `private` visibility through the asynchronous create operation; `currentCreation()` exposes it only inside that operation.
- `CollaborationError` preserves stable denial codes for RPC and HTTP Consumers. Providers fail closed when membership, visibility, or their authorization backend cannot be established.

## Model Experience

Indirectly, through authorization Consumers whose durable participant attribution is owned by `dsh-collaboration-context`.

#### KV Cache effect

The Service Definition contributes no request tokens and does not alter an already-reusable prefix.

## Known Limitations and Deferred Work

- **Root-owned visibility** — descendants cannot carry independent visibility; every read, write, manage, and approval decision resolves through the root conversation.
- **No membership mutation API** — project membership remains a Gateway/admin responsibility, outside this Service Definition.
- **One production provider** — `dsh-collaboration-gateway` is the only shipped provider; alternate deployments must implement all authority operations rather than bypass individual checks.
