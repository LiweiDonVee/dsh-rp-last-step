# 架构、工具与公开方向包

## 运行路径

主 Agent 及已有工具决定事实，`rp_present` 接收公开方向包，受限组装模型调整会话覆盖，编译器校验并冻结输入，独立 writer 生成正文，DSH 接受规范工具结果后才将呈现记录标为完成。

这条路径没有模拟或结算引擎。`execute.concludeTurn()` 只在终止工具成功后调用，避免主模型把正文再复述一遍。终止工具必须是当前消息唯一的直接工具调用，不接受在 PTC 或嵌套工具中调用。

| 文件 | 职责 |
| --- | --- |
| `src/core.mjs` | ST 导入、Profile/Overlay、权限操作与编译 |
| `src/store.mjs` | 不可变来源/版本、固定会话绑定、revision 写入 |
| `src/presenter.mjs` | 迁移、受限模块组装、输入冻结、thought 过滤 |
| `src/models.mjs` | 独立 LLM 调用与实际模型配置 |
| `src/receipts.mjs` | 呈现记录、上下文幂等预留和公开投影 |
| `src/agent.mjs` | 原生 agent 作用域工具与动态上下文 |
| `src/host.mjs`、`routes.mjs` | owner Remote 授权、宿主生命周期、可选服务与浏览器接口 |
| `src/PresetWorkspace.jsx`、`client.jsx` | 原生编辑器、稿件记录与可选 Studio 入口 |

## 工具合同

仅就绪绑定的原生会话获得以下工具；不要在 preset 中另装内部 `agent.mjs`。根插件已经管理工具作用域和客户端入口。

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `rp_last_step_catalog` | `{}` | 取得当前目录、策略与 revision |
| `rp_last_step_read` | `{entryIds: [id]}` | 按需读取模块正文 |
| `rp_last_step_patch` | `{expectedRevision, operations}` | 原子修改本会话覆盖 |
| `rp_present` | `{packet}` 或 `{rewriteOf}` | 独立生成正文；失败稿可用冻结材料只重试 writer |

补丁操作是 `enable`、`disable`、`replace`、`fill`、`add`、`remove`。来源条目不能删除；remove 仅用于临时新增条目，新增条目只允许呈现阶段且不能冒充来源、必用或锁定条目。策略、阶段、绑定和源版本由 owner API 管理。

## 公开方向包

以下是 `rp_present` 参数示例，完整文件位于 [examples/public-direction-packet.json](../examples/public-direction-packet.json)：

```json
{
  "packet": {
    "playerAction": "我试着推开门。",
    "sceneInstruction": "只写本轮结果与可见反应。",
    "resolvedChanges": ["推门失败，门没有打开。"],
    "visibleConsequences": ["门内传来插闩的轻响。"],
    "openHooks": ["门外的人仍可继续交涉。"],
    "proseConstraints": ["保持失败结果，不替玩家选择下一步。"],
    "publicFactRefs": ["door-check:turn-1"],
    "variables": {"tone": "克制"}
  }
}
```

`playerAction` 必填。其余文本字段/字符串数组为可选；`variables` 的值必须为字符串。这里只接受白名单字段，不接受原始状态、私密世界书、推理或原始工具输出。`publicFactRefs` 是调用方给出的公开引用，不会触发自动读取或检索。

不能把“writer 没有世界工具”误解为“包内任何内容都适合公开”。事实选择由调用方负责，正文模型只能在指定范围内进行文学呈现。正文文本会过滤已知 thought 标签和独立 reasoning 块，但这不是语义保密证明。

## 预设模型与存储

Profile 记录 `id/name/version/status/sourceId/entries`。条目包含 `id/name/content/role/order/enabled/phase/required/locked`，可带来源、标记和填充。阶段为 `unclassified/agent/render/shared`，状态为 `draft/ready`。

Overlay 形状为 `{entries: {[entryId]: {enabled?, content?, fills?}}, additions: []}`。它不拥有策略或阶段修改权限。持久化：

```text
$DSH_HOME/app-data/rp-last-step/
  presets/preset-store.json
  presentations/          # 按会话索引的呈现记录
```

保存使用 revision 比较，现有 Profile 还要求明确的当前基础版本。组装在捕获版本上校验和提交，不自动将冲突补丁重放到新版本。

## 浏览器与可选集成

`POST api/rp-last-step/request` 支持 `state/profile/source/createProfile/importSillyTavern/saveProfile/bindSession/preview/migrate`。写操作带 `expectedRevision`，绑定/迁移显式指定版本；精确 DTO 以 `src/routes.mjs` 为准。SSE `api/rp-last-step/events?sessionId=...` 仅发变更和阶段元数据，不发私有组装文本。

Loop Studio 通过可选服务注册迁移、组装、正文节点并解析冻结路由。RP Studio 通过可选 `rp.studio.workspace.actions` 槽打开编辑器，通过进程内安全正文事件获得流式文本；持久化叙事使用规范 tool/result 的 `meta.rpLastStep`。它不是自定义 Session 事件类型。

Studio 回放使用原始工具调用关联与 `sourceEventSeqs`，而不是仅靠可能复用的 provider 工具 ID。模型处理文字在已启用最后一步的区间不作为 GM 旁白，普通旧故事不受此规则改变。独立记录页是已提交稿件档案，不是分支投影。

## 0.2 材料准备与失败重试

安装可选 rpContext 后，present 在原子预留呈现记录之后、文风模块组装之前调用中间 GM。GM 借助可选 rpDatabase 主动搜索、读取、选择、排序和编辑允许的会话条目，并决定历史表示。返回的内容快照、版本/来源引用、最近正文和指导冻结到 contextPreparation，再作为独立数据交给组装模型和 writer。

公开结果只记录材料 ID、数据库/历史引用、实际模型与字符规模，不附带整个数据库正文。完整材料保存在本机呈现记录中供回溯；后续数据库变化不影响本次输入。上下文关闭或未安装时使用旧行为。

rp_last_step_catalog 的 presentations 只列出当前可重试失败记录。rp_present({rewriteOf:id}) 仍必须是唯一直接终止调用，只接受已失败/取消且已冻结编译结果的本会话稿件。它不再次运行 GM、模块组装或事实工具，也不覆盖成功稿件。

原失败链的规范来源必须仍在当前有效分支。列表、执行及 receipt 原子预留共享资格判断；有效成功重试消耗该失败链，运行中的重试拒绝并发重复。若成功重试已被回退，则按当前活跃来源重新判断；没有以永久标记锁死旧失败记录。正文成功后仍需规范工具结果接受，才进入正式叙事。
