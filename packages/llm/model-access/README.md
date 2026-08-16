# @deepseek-ai/dsh-model-access

English | [中文](README.zh.md)

Service Definition for deployment-owned authorization of exact `(provider, model)` routes. `ModelAccessService` is the runtime face published as `ctx.modelAccess`; implementations may be plain objects. `ModelAccessPolicy` is an optional Cordis `Service` base for in-tree providers. Consumers use the same decision for catalogs, model selection, and execution. Absence of the service means no model authorization policy is mounted.

## Model Experience

None, as this package defines a policy interface and contributes no model input itself.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

- **No policy storage** — deployments must mount a provider that owns policy persistence and refresh semantics.
