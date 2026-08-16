# @deepseek-ai/dsh-client-ui-usage-alert

English | [中文](README.zh.md)

Gateway quota warnings in the global Web shell. The browser plugin contributes one `shell.overlay` entry. Its apply-side callback reads the authenticated same-origin `/account/api/usage` summary once on mount; the presentation component displays only durable natural-month 80%/100% crossings already computed by the gateway. A failed advisory read leaves the shell unchanged.

## Model Experience

None, as this package renders account usage metadata and contributes no model input.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

- **Mount-time refresh only** — a threshold crossed while one tab remains open appears after the next page load; the gateway remains the durable alert owner.
