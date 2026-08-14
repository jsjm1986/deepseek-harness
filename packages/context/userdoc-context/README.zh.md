# @deepseek-ai/dsh-userdoc-context

[English](README.md) | 中文

面向 `ctx.userDocs` 的提示上下文插件。在提示准入前校验上传文档标识，选择精确的内联文本或仅路径表示，并把主机准入后的快照记录到 Session 日志。

## 公共 API

`prepareUserDocAttachments()` 在 Host 调用 `followup()` 或 `steer()` 前解析整批文档。它强制执行 `UserDocLimits.maxFilesPerMessage` 与 `maxMessageBytes`；不超过 `maxInlineTextBytes` 的文件会读取一次，只有严格 UTF-8 字节才会内联。其他文件保留为路径引用，由 agent 已有的文件系统工具读取。`renderUserDocAttachment()` 把冻结后的表示渲染为文本块。

确切的 `user/message` 事件追加后，插件为每个文档追加一个 `userdoc/attached` 事件。每个事件包含所引用的消息标识、文档索引、元数据，以及出现在用户消息中的表示，因此重放可以验证模型可见的文档上下文由 Host 准入，而不是由浏览器提供。

## 模型体验

### 已准入的文档上下文

#### 模型看到的内容

每个上传文档在用户消息中变成一个文本块。较小且能严格解码为 UTF-8 的文件会包含其内容；更大或二进制文件会给出 agent 文件系统工具可以读取的普通主机路径。

##### 内联表示

```markdown
Uploaded document "notes.txt" at "/workspace/uploads/2026-08-14/notes.txt"; contents inlined verbatim:
<file contents>
```

##### 路径表示

```markdown
Uploaded document "report.pdf" is available at "/workspace/uploads/2026-08-14/report.pdf". Use the filesystem tools to read it.
```

#### Token 影响

内联文档会消耗渲染进用户消息的 UTF-8 字节，并受 `maxInlineTextBytes` 与消息总限额约束。仅路径文档只增加一段短引用，把格式相关的读取留给后续工具调用。

#### KV Cache 影响

渲染后的文档文本属于追加式用户消息后缀。复用会话会保留更早的提示历史；新上传只改变新消息后缀，而仅路径文档不会把文件字节载入模型请求。

## 已知限制与后续工作

- **不解析文档**——插件不抽取 PDF、表格、图片或压缩包文本。二进制与无法解码的文件保持路径引用，由 agent 的工具决定如何检查。
- **准入时冻结快照**——内联字节与引用元数据在提示进入 Session 前冻结；普通文件在准入后的变化不会改写那条历史消息。
- **没有历史浏览器库**——浏览器 rail 只管理当前草稿，持久文件仍在工作区内，通过 Host 文档服务列举或删除。
