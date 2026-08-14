# Agent Note: 响应式外壳视口模式与度量 token

Status: implemented

[English](2026-08-14-responsive-shell-viewport-modes.md) | 中文

## Problem

Web GUI 曾是桌面优先：外壳按 640px 中心下限求解三栏网格，唯一断点是 1024 侧边栏自动折叠，手机宽度的窗口只能渲染出不可用的挤压布局。功能面板各自硬编码了五个互不相关的 `@media` 断点（560/680/720/760）和自己的 px 间距，每个新功能都要重新发明宽度行为。UI 由 20+ 个渲染进 slot 的 `ui-*` 插件组成，插件看不到自己容器的宽度，这排除了基于面板各自测量窗口的约定。

## Decision

`ui-layout` 拥有共享宽度语汇（`viewport.ts`）：`compact` <768、`medium` 768–1023、`expanded` 1024–1439、`wide` ≥1440，`SIDEBAR_AUTO_COLLAPSE` 改由 medium/expanded 边界派生。AppFrame 把当前档位以 `data-viewport` 标记在框架根元素上，并据此渲染三种模式之一：expanded/wide 原样保留三栏让步链；medium 保留控制栏或挤压展开的侧边栏列，把详情栏提升为可经遮罩关闭的右缘浮层（否则让步链会把它自动关闭）；compact 在外壳顶栏下渲染单栏，顶栏开关拥有侧边栏抽屉，详情栏铺满整宽。浮层以 transform 隐藏，因此开合从不重挂已挂载的 slot；compact 下的会话导航与缩窗进入 compact 都会收起抽屉 override；框架跟随 `--dsw-viewport-height`（由 `visualViewport` 发布、折出捏合缩放系数），使输入条保持在屏幕键盘上方。

面板通过匿名容器查询在共享的 480/560/720 档位上自适应：CSS Modules 会按模块对 `container-name` 做哈希，跨包的命名容器永远无法匹配；外壳三列刻意不声明 `container-type`，因为 layout containment 会改变树内 `position: fixed` 表面（lightbox、拖放遮罩、设置面板）的包含块。`ui-theme/styles/metrics.css` 新增与主题无关的度量 token——`--dsw-space-1..8`（4px 步进）、`--dsw-radius-*`、`viewport-fit=cover` 下基于 `env(safe-area-inset-*)` 的 `--dsw-safe-*`，以及 `--dsw-touch-target`（44px）——并把 90 个客户端样式表中的 619 处间距/圆角字面量做了取值不变的改写。触控基线落在 ui-primitives（底部面板化的 Modal、compact 内联子菜单、粗指针行高、防 iOS 聚焦缩放的 16px Input 文字、隐藏的 Tooltip 气泡），另加详情拖拽胶囊与工具 inspect 胶囊的粗指针常显；portal 表面用 `useMediaQuery` 分支，因为它们看不到框架标记。规范以 docs/web-styling.md 为准。

## Alternatives considered

- **用 `@custom-media` 共享断点定义**——被拒：客户端 CSS 由两条独立管线编译（外壳走 Vite，插件包走 tsdown 内的 lightningcss），一个两边都要配置才能解析的草案语法把构建路径耦合在一起，而 DOM 属性天然表达同一事实。
- **在外壳三列上声明 `container-type`**——被拒：layout containment 会改变每个树内 `position: fixed` 后代的包含块，而今天有多个未 portal 的浮层位于列内。容器保持面板自有且匿名。
- **medium 侧边栏抽屉化**——被拒：768–1023 的窗口保留已交付的挤压展开语义，内容在会话切换期间仍可点击；只有 compact 采用模态抽屉。
- **粗指针下把所有 Button 提到 44px**——被拒：36px 按钮凭周围间距已可点按，一刀切放大会重排与桌面共享的密集布局；只放大 40px 以下的控件（菜单行、关闭图标）。

## Consequences

跨越模式边界会重挂侧边栏与详情子树（旋转或拖窗跨过 768/1024 时其视图状态重置），换来的是同一模式内开合从不重挂任何东西。compact 下外壳顶栏叠在对话自己的会话头之上，纵向空间花了两份，待会话头自适应后收敛。619 处 token 改写取值不变，但让未来的密度调整变成单点改动；三处与 `-4px` 拉回配对抵消的字面量 `4px` 保持字面量，并由 workspace/sidebar 的间距规格断言。chat-scroll e2e 的窄视口场景从 700 移到 800px，因为 <768 现在意味着内容之上的模态抽屉而非挤压列。

## Testing

jsdom 规格覆盖模式决策（抽屉、遮罩、顶栏标记、会话导航收起、medium 浮层详情、挤压态缩入 compact 的折叠），以及 `viewportClassOf`、`collapseNarrow`、`useMediaQuery` 和可视视口变量的生命周期。keyless 的 `responsive-shell.e2e.ts` 在 390/900/1280/1680 下走查组装后的应用并带 compact 抽屉 ARIA golden，补上了 `dsh-client-web` README 此前声明的窄视口验收缺口；外壳相关的 e2e 集合 replay 全绿。
