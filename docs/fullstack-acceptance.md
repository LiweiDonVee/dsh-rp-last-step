# 数据库、主动上下文与最后一步组合验收

2026-10-25，官方 DSH 0.2.1-rc.2，Node24、pnpm11.9，独立临时 DSH home。提供方、embedding、rerank、GM、摘要与 writer 全部是明确标识的本地确定性 fixture，没有真实付费推理或用户角色卡。

## 覆盖

- 各新插件可只安装自己的 tgz，原生入口、侧栏、全屏、520px、关闭重开均通过；独立上下文验收不要求数据库或最后一步包。
- 组合安装数据库、上下文、最后一步0.2和 Loop0.1。主 Agent 调用事实工具，GM 用不同模型准备材料，文风组装和 writer 使用独立实际路由。
- 初始20个候选没有目标条目，GM 主动搜索完整启用库并读取候选外目标。真实本地 HTTP embedding/rerank 接口收到请求，禁用哨兵不在其输入中。
- GM 试图改写只读必开条目被拒绝，之后合法修改、新建和临时备注进入会话覆盖。源数据库的 BOM、CRLF 和原始文本保持不变。
- 正文默认窗口设为1：早期正文生成实际事实摘要，GM 按规范来源展开原文，并在后续改为索引。未决事项独立保留。
- 四轮成功叙事后，第五轮 writer 人为失败。数据库的已提交变化保持，失败稿不进入正式历史；仅重试 writer 后累计5次事实工具、6次 writer，GM/组装不重复执行。
- 在第二轮结束事件处分叉，子会话只继承第2次数据库变化和2条叙事，父会话的后续变化不进入子分支。随后用宿主合法 surface replacement 回退第五轮和重试，打开的数据库视图自动恢复到第4次变化，旧失败来源不再可重试。宿主重启后资料与4条有效叙事恢复。
- 完整来源关联包含 assistant message ID、sourceEventSeqs 与工具事件序号；提供方复用工具调用 ID 不串回合。
- Astra 最终审查发现的失效来源重试、成功重试重复和数据库视图失效通知已修复，并通过定向回归与复核。

单元测试合计229项：数据库43运行时＋14界面，上下文36运行时＋17界面，最后一步98运行时＋21界面。三个项目的 lint 和生产构建通过。

## 复验

每个仓库执行 pnpm check、pnpm package、pnpm smoke。组合在最后一步仓库运行：

```powershell
$env:DSH_DATABASE_TGZ = (Resolve-Path ../downloads/dsh-rp-database-0.1.0.tgz).Path
$env:DSH_CONTEXT_TGZ = (Resolve-Path ../downloads/dsh-rp-context-0.1.0.tgz).Path
$env:DSH_LOOP_TGZ = (Resolve-Path ../downloads/dsh-loop-studio-0.1.0.tgz).Path
node scripts/fullstack-smoke.mjs
```

改为实际下载路径。需要官方启动器与 Playwright Chromium，可用 DSH_BIN 和 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 指定。结果 .runtime/fullstack-evidence/acceptance.json 保存受测安装包哈希，截图在同目录。Release 附 SHA256SUMS 对应正式安装包。

## 范围

上下文窗口作用于中间 GM 与最终正文，不篡改宿主主循环的冻结请求；主循环全局压缩仍由 DSH／经过对应版本验证的 ACP 管理。没有执行历史 DV fork 或上游脚本，也没有把它们当作依赖。

这是工程调用与生命周期验收，不能代替20—30轮真实模型的文学质量、角色一致性或大库检索效果评测。当前表示以正式叙事回合为单位，未宣称实现无限层级章节压缩。embedding 在检索时按有效内容计算，未验证持久向量索引性能。人物知情依靠叙事备注与 GM 判断，不是程序保密证明。
