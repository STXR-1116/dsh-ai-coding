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

### 2.2 类型增广失效 ⇒ 129 条编译错误，但**根因很少**

用 `paths` 把 `@deepseek-ai/*` 全部指向 DSH 安装里的 **0.2.1-rc.2 类型**做了一次编译：**【实测】**

```
error 数量：129
按错误码：TS2339(22) TS7031(15) TS7006(13) TS2345(11) TS2344(7) TS2322(4) TS2367(3) TS18046(2)
```

典型：

```
Property 'slots' does not exist on type 'Context'          ← 服务增广没生效
Property 'sessions' / 'locale' / 'layout' 同上
Type '"sidebar.footer.action"' does not satisfy 'never'    ← SlotMap 在我们这边是空的
```

**28 条"隐式 any" + 7 条"约束不满足"都是上面两条的下游连锁**，不是 129 个独立破坏。**{推断}**

而 0.2.1 里 `slots` 服务与 `SlotMap` **仍在同类包里声明** **【随包类型】**：

```
slots 服务：dsh-client-ui-renderer/lib/types/client/index.d.ts:27
           dsh-cordis-client-runner/lib/types/client/runtime.d.ts:98
SlotMap  ：dsh-client-ui-layout / dsh-client-ui-conversation / dsh-client-ui-chat / … 各自的 contract/slots.d.ts
```

⇒ 结论：**机制没变**，是**增广没有被加载进来**（我们代码里那些
`import type {} from '@deepseek-ai/…'` 的副作用导入指向了不再携带增广的模块路径）。**{推断，需验证}**

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

### 3.4 构建环境：**直接安装 0.2.1-rc.2 的类型**（修正掉上一版结论）

**上一版写"registry 不可达、只能 vendor 类型"是错的**，必须更正：

- 我先前的依据是**几天前**的一次探测；这次复核时我又用 `Invoke-WebRequest` 测了一遍，
  报的是 PowerShell 的 `NonInteractive` 提示错误 —— **那是我的工具有问题，不是网络结论**。
- 复核结果 **【实测】**：
  - `npm ping` → **PONG，3.6 s**（registry 可达）；
  - `npm view @deepseek-ai/dsh-session@0.2.1-rc.2 version` → **`0.2.1-rc.2`**（这个版本确实在仓库里）；
  - 代价是**慢**：单次 `npm view` 约 **39 s**，所以 `pnpm install` 会明显变慢，但不阻塞。
- 本仓 `node_modules` 目前仍是 **0.1.5-rc.2**（构建实际用的就是它）。

⇒ **做法**：T1 里直接 `pnpm add -D`（或改 `package.json` 后 `pnpm install`）把 30 余个
`@deepseek-ai/*` 升到 `0.2.1-rc.2`，让**类型检查与运行时版本一致**；不再需要 vendor 脚本。
安装耗时长要预留时间，失败时按普通网络重试处理。


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
