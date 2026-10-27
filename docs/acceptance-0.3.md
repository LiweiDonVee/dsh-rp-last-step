# 0.3 原生验收

本页为历史 0.3 范围；当前 0.4 源码检查点及新流程待验收状态见[验收记录](acceptance.md)。下列结果不迁移为 0.4 新流程 PASS。

环境：Windows、Node 24、pnpm 11.9、实际官方 DSH 0.2.1-rc.3。执行 `pnpm check`、`pnpm package`、`pnpm smoke:drafts`；包哈希见产物 SHA256SUMS 与运行生成的 acceptance.json。

原生脚本将当前仓库的真实 tgz 安装到隔离 web profile。所有模型来自明确的本地 deterministic adapter，事实工具是合成的 gate 判定；Context 是合同夹具。没有用户角色卡、脚本执行或真实付费提供方。

已覆盖：

- 真实事实工具先执行一次，独立组装／writer 成功，经实际规范 rp_present 接受。
- 另一稿只调用 writer；直接手改和保存版本没有模型调用。UI 比较、采用同时核对 NarrativeRef 和 expectedDraftVersion，过期版本与来源拒绝。
- 采用只替换有效 content，旧 metadata 保持原档案；派生主模型消息使用新正文。原生维护回合仍为 blocked，操作成功由 command 确认，模型／事实计数不增加。
- 请求特定 retry guard 拒绝事实工具、错误 ID、额外 packet；模型未返回工具时明确失败。正确 UI 重试只增加一次主派发和一次 writer，Context、事实和组装计数不增加。
- fork 在采用前后保留各自正文，profile/overlay 来自对应前缀；进程重启冷读保持事件前缀相等，resume 不重新执行历史。
- 第二个独立 home 先通过公开 sessionPersistence 写入 exact header/events/inheritedEventCount，冷验证后恢复 LastStep 的 profile／receipt／draft 状态。无关目的地数据保留，同 restoreId 幂等；再 resume、fork 和冷重启，历史模型／工具计数为零。
- 实际原生侧栏、全屏和窄屏截图；无浏览器 pageerror。冻结材料只读原输入，未记录字段显示缺失。

默认证据在 `.runtime/last-step-drafts-evidence/`，包括 acceptance.json、before-restart.json、脱敏宿主日志与 PNG。owner-state 单元测试另验证三处目录切换故障后的完整恢复，以及写前持久 generation 与稳定读取等待。

此范围验证 LastStep 的真实宿主执行与自身恢复。真实 GM/Database/Context 的事实／笔记分支投影、StoryKit 全存档协调、Studio 联读与 Loop 实际路由组合须由对应版本的整栈验收证明。旧版 `acceptance.md`、`fullstack-acceptance.md` 的 rc.2 结果不扩大到本版。
