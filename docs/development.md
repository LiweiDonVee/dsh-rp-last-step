# 开发与验收

## 构建

需要 Node.js 24、pnpm 11.9；不依赖 RP Studio 或 Loop Studio 工作区：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm package
```

`check` 运行零 warning lint、Node 宿主/内核测试、Vitest React UI 测试和 host/client 生产构建。当前 0.4.1 的 `package` 生成 `artifacts/dsh-rp-last-step-0.4.1.tgz` 与 `SHA256SUMS.txt`。

构建会将 `skills/adapting-sillytavern-rp-presets/` 复制到 `dist/skills/`，宿主注册这份标准 skill 正文与资源目录。发布包包含打包后的 host、ModuleLoader client、skill、manifest、Cordis patch、README 和许可证；开发依赖不进入安装要求。

UI 测试在 `tests/ui/`，Node 测试在 `tests/*.test.mjs`，两者分开运行。CI 在 Ubuntu 和 Windows 进行冻结依赖安装、check 和打包；不进行付费模型验收。

## 单插件原生验收

安装官方 DSH 0.2.1-rc.3 和 Playwright Chromium：

```powershell
pnpm exec playwright install chromium
pnpm package
pnpm smoke
```

脚本默认只安装本插件，创建 `.runtime/rp-step-smoke-*` 隔离 home。合成 ST 预设、模拟模型和事实工具覆盖导入、迁移、只读模块、编译、两轮终止呈现、会话模型继承、原件保留和生成记录。没有真实模型请求，不读用户角色卡。

`DSH_BIN` 可指定官方启动器；Windows 默认使用 LOCALAPPDATA 下的 DSH 安装。已有 Chromium 可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。

## 三插件联用验收

下面保留旧三插件 harness 的范围和输入示例，不是 0.4 新审批／正文修订的验收命令；当前源码与待验收边界见[验收记录](acceptance.md)。

从相关 Release 下载另外两个已构建包，再执行：

```powershell
$env:DSH_LOOP_TGZ = (Resolve-Path ../downloads/dsh-loop-studio-0.1.0.tgz).Path
$env:DSH_STUDIO_TGZ = (Resolve-Path ../downloads/dsh-rp-studio-1.2.0.tgz).Path
pnpm smoke -- --integration
```

将示例下载路径改为本机文件位置。联用模式仍使用新 home 和模拟模型，检查迁移/组装/正文各自路由、未绑定工具隔离、待选模型、主 Agent 与正文隔离、锁拒绝后的合法填充、安全流、规范回放、复用工具 ID 和 Loop 原生控件。

独立验收结果位于 `.runtime/rp-step-alone-evidence/`，联用结果位于 `.runtime/rp-step-evidence/`。`acceptance.json` 保存各次受测包哈希；实际验证范围见[当前与历史验收记录](acceptance.md)。

## 修改与发布

0.3 原生回归使用 `pnpm smoke:drafts`，需要先 `pnpm package`。可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向已缓存 Chromium；`DSH_LAST_STEP_EVIDENCE` 指定证据目录，默认 `.runtime/last-step-drafts-evidence/`。脚本独立临时 home 安装实际 tgz，执行手改／采用／受限重试 UI、fork、冷重启，再在第二个 home 通过公开 persistence 导入 exact Session 和本插件 state，验证零历史调用与再次 fork。Context 使用明确合同夹具，GM 使用本地事实工具；这不是完整 GM/Database/Context/Studio 组合或付费模型质量验收。

`tests/owner-state.test.mjs` 注入 before-switch、between-renames、after-install 故障；所有恢复文件都在随机测试 owner namespace。aggregate revision 与旧 preset revision 域、候选／canonical drain、Session ancestry、restore 冲突和审计读取均有 focused Node 覆盖。旧组合脚本和 `fullstack-acceptance.md` 的 rc.2 范围是历史记录。

权限修改应同时检查操作接口、编译器与批量原子性；模型流程修改应检查准备配置与实际调用一致、取消和重复提交，以及失败后是否重复执行事实工具。

迁移的源元数据只供迁移使用，不应泄漏到 writer。skill 变化可对照 [已有行为演练](skill-evaluation.md)，并用合成成功、失败、锁冲突和未知宏案例检验。不要将真实用户预设提交为测试 fixture。

版本更新同步改 `package.json` 和 `CHANGELOG.md`。通过 check/package/原生 smoke 后，将 tgz 与 SHA256SUMS 上传到对应 GitHub Release。不要用只通过模拟模型的结果宣称真实模型的文学质量或完整 ST 脚本兼容。
