# DSH 0.2.1-rc.2 适配方案（设计稿）

> 状态：**待评审**（按所有者要求先设计后开工）。
> 证据强度标注：**【实测】** = 本机跑出来的；**【随包类型】** = 读 0.2.1-rc.2 的随包 `.d.ts`；
> **【推断】** = 合理但未验证，不当结论用。

---

## 1. 现象

升级到 `dsh 0.2.1-rc.2` 后启动报错：

```
dsh: disabling profile plugin row "workspace": Plugin @deepseek-ai/dsh-workspace@0.1.5-rc.2 is incompatible
     with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-invariants":"^0.1.5-rc.2", …}
     Exact-version exemption: not active.
```

插件已被所有者**暂时卸载**。卸载后 profile 里出现 `package.json.bak-preuninstall` /
`pnpm-lock.yaml.bak-preuninstall`，且 `package.json` 里**已无任何依赖**，但错误仍然指向
`@deepseek-ai/dsh-workspace@0.1.5-rc.2`。**【实测】**

## 2. 根因（两件事，互相独立）

### 2.1 我们把运行时包钉成了**自己的依赖** ⇒ 把旧版本钉进了 profile

本仓 `package.json` 把 **31 个 `@deepseek-ai/*` 包固定在 `0.1.5-rc.2`**，且放在
**`dependencies`/`devDependencies`** 里。**【实测】** 安装插件时，profile 就把这些旧版本
**装进了自己的依赖树** ⇒ loader 按行对账时发现 `dsh-workspace@0.1.5-rc.2` 与
`dsh 0.2.1-rc.2` 的 requirements 不符 ⇒ 禁用该行。

**官方插件不是这个形态** **【随包类型 + 包清单】**：

| 官方包 | dependencies | peerDependencies |
| --- | --- | --- |
| `dsh-client-ui-workspace` | （空） | `@deepseek-ai/cordis` |
| `dsh-client-ui-sidebar` | （空） | `@deepseek-ai/cordis` |
| `dsh-client-ui-chat` | `@deepseek-ai/schemastery` | `@deepseek-ai/cordis` |

⇒ **运行时框架包走 `peerDependencies`，插件不自带运行时**；只有独立库（`schemastery`）才是普通依赖。

> 卸载后仍报错，是因为 profile 的**陈旧 lockfile / node_modules 残留**仍在参与解析。**【实测：目录里有 `*.bak-preuninstall`】**

### 2.2 类型增广失效 ⇒ **真实规模是 516 条**（此前的 129 条是"混装树"造成的假象）

第一次探测（用 `paths` 指向 DSH 安装的类型）报 **129 条**；但那次 `node_modules` 里
**还留着 `dsh-client-ui-slots@0.1.5-rc.2`**（0.2.1 里**已经没有这个包**），于是我们的旧导入
仍然解析得通 —— 数字被**低估**了。

把运行时包从本机 DSH 安装 vendor 过来、并**删掉那个残留**之后，`tsc` 对干净的 0.2.1 类型报：

```
516 条
按文件：CloudWorkspacesView 146 / gateway 17 / memory-loop 13 / PlatformSurface 12 / index 11 / AgentConfigView 9 …
典型：Argument of type 'unknown' is not assignable to parameter of type 'WorkspaceQueryResult<…>'
      'result' is of type 'unknown'
```

⇒ 主导原因不是"导入路径"（那只是一小部分），而是 **typert / 传输层的返回类型变了**（退化为 `unknown`），
**每一处远程调用点都要重新取型**。**【实测】**


## 3. 方案

### 3.1 依赖形态：把运行时包改成 `peerDependencies`

- `@deepseek-ai/dsh-*` / `@deepseek-ai/cordis` / `@deepseek-ai/schemastery`：
  - `peerDependencies` 声明**兼容范围**（`^0.2.1-rc.2`，cordis 按实际主版本）；
  - 本地构建用 `devDependencies`（或 vendored 类型，见 3.4）；
  - **从 `dependencies` 里移除** —— 这样插件不再把任何运行时版本钉进 profile。
- 这是我们自己的包（`dsh-ai-coding`）唯一的运行时依赖面收敛点，改一次以后每次升级 DSH 都不再需要动它。

### 3.2 类型增广修复

1. 逐条修 `import type {} from …` 的**副作用导入路径**（0.2.1 的模块布局）；
2. 断言 129 → 0；
3. 把"为什么需要这些副作用导入"写进 `src/client/index.ts` 顶部（现在散落在注释里，容易被当成无用导入删掉）。

### 3.3 profile 清理（用户侧一步）

```pwsh
# 删掉陈旧解析结果，让 profile 只保留自己的两个 bundle
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules" -Recurse -Force
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml" -Force
# 再装新版插件（peer 依赖会被运行时满足）
```

> 具体命令以 3.4 的安装方式为准；目标是**让 `dsh-workspace` 那一行不再指向 0.1.5-rc.2**。

### 3.4 构建环境：**从本机 DSH 安装 vendor 运行时包**（结论再修正）

上一版写"registry 可达，直接 `pnpm install` 就行"—— 也**不成立**：

- `npm ping` 确实 PONG（3.6 s）、`npm view …@0.2.1-rc.2` 也确实查得到，所以"不可达"是错的；
- **但** `pnpm install` 实测反复 `UND_ERR_DESTROYED` 断流，并最终死在
  **`ERR_PNPM_NO_MATCHING_VERSION: @deepseek-ai/dsh-invariants@0.2.1-rc.2`**
  —— 该包在仓库里最新是 `0.0.1-rc.1`（tag `next` 为 `0.2.0-rc.2`），**根本没有 0.2.1-rc.2**：
  它只随 DSH 安装分发。**【实测】**

⇒ **采用**：`build/vendor-dsh-runtime.mjs` 从本机 DSH 安装把运行时包（类型 + 代码）
复制进 `node_modules/@deepseek-ai/*`（复制前先删目标，避免 0.1.5 与 0.2.1 混装）。

配套的两条硬约束（都是实测踩出来的）：

1. **`devDependencies` 里不声明任何 `@deepseek-ai/*`** —— 否则每一次 `pnpm` 调用都会先尝试安装，
   然后因为上面那个"仓库里没有该版本"而失败（连 `pnpm typecheck` 都跑不到 `tsc`）；
   运行时包只留在 **`peerDependencies`**（由运行时满足），本地类型检查用 vendor 的副本。
2. 本机必须装有**同版本** DSH（本工作流本就如此）；否则先跑 vendor 脚本再构建。



## 4. 分步计划（每步可验，随时可退）

| 步 | 内容 | 验证 |
| --- | --- | --- |
| **T1** | 换依赖形态（peer）+ vendor 0.2.1 类型 + 修副作用导入 ⇒ **129 → 0** | `pnpm typecheck` 0 错误；全量套件绿 |
| **T2** | 逐条回归我们真正依赖的 API（3 个席位 + 7 个 remote 命名空间 + 会话/布局服务） | 全量绿 + 每条失败都能指到具体 API |
| **T3** | 构建 → 打包 → 装进 profile（清理陈旧解析）→ **mount-smoke** | 冒烟 GREEN 23/23（含接管那三条真机判据） |
| **T4** | 真机验收接管模式（左栏两段 / 标志 / 退出还原 / 会话切换） | 所有者验收 |

## 5. 风险与回退

| 风险 | 处理 |
| --- | --- |
| 类型对齐 ≠ 行为对齐（0.2.1 可能改了运行时语义） | 只靠冒烟能发现 ⇒ T3 是硬门；冒烟里已有"浮层自动关闭""退出即还原"两条真机判据 |
| peer 范围写太宽/太窄 | 用 `^0.2.1-rc.2`；升级到 0.3 时显式再评 |
| profile 清理误删用户数据 | 只删 `node_modules` 与 `pnpm-lock.yaml`（可重建），不碰 `cordis.patch.yml` / `cordis.yml` / `.env` |
| 适配失败 | 版本可回退：保留当前 tgz 与 `*.bak-preuninstall`；profile 可重建 |

## 6. 明确不做

- **不**在插件里重新实现 DSH 运行时包（那正是这次问题的来源）；
- **不**用 `dsh plugin allow-version` 绕开兼容检查 —— 那是"我知道会崩但先这样"的开关，
  对交付物不适用（所有者也没要求这么做）；
- **不**在没有冒烟通过前报"已适配"。
