# 本仓工作约定

## 先查官方文档，再动手（**强制**）

**定位任何问题、写或改任何 DSH 插件代码之前，先查 `docs/dsh-docs-index.md`。** 它把「任务形状 →
该读哪一页」做成路由表，指向本地纯文本镜像 `~/.dsh/dsh-manual/`（86 个站点页 + 17 份仓库文档，
可 grep、离线；用 `build/fetch-dsh-manual.ps1` 刷新）。

两条最容易踩的：

- **只读 `develop/` 是不够的。** 本仓最难的两个问题（测试时钟该不该 mock、「单跑才通过」算谁的
  缺陷）的答案都在**文档站之外**：`docs/testing.zh.md` 与 `.agents/skills/dsh-ci-test-reliability/`。
  索引里单列了这一类。
- **浏览器半不是未文档化。** 参考区有整个客户端平面（`client-modules` / `slots` / `web-client` /
  `typert` / `web-server` 等）。改 `src/client/**` 前先读对应页。

**不许凭印象猜规范**：写进代码或文档的规则要能指回具体页；文档确实未覆盖时，显式标注
「手册未覆盖，依据为随包源码 + 实测」。

## 改了插件代码，必须走完收尾清单才算「完成」（**强制**）

**仓库里的代码 ≠ 用户运行时跑的代码。** 只 build 不安装，等于没修：本仓已经发生过一次
——0.1.6 修掉了「配错地址就回不去」的死结，但 profile 里仍是 0.1.5，用户继续撞同一个 bug，
而我报了「已修」。**在装上去并冒烟通过之前，不要说「已完成」。**

固定收尾序列：

```pwsh
# 1) 递增版本 —— 必做，理由见下
node -e "const f='package.json',p=require('./'+f);p.version='0.1.N';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
pnpm build
pnpm pack
dsh plugin --profile web add (Resolve-Path dsh-ai-coding-<version>.tgz).Path
node build/mount-smoke.mjs 8090        # 必须 GREEN，失败就不是完成
```

两条会静默咬人的前提：

- **同版本重装不会更新。** `dsh plugin add` 走 profile lockfile 里记录的完整性，从 pnpm store
  还原**旧内容**；版本号没变就等于没装。所以**每次改完都要递增 `version`**，或删掉
  `node_modules/dsh-ai-coding` **与** profile 的 `pnpm-lock.yaml` 再装。
- **别删还在被引用的 tarball。** profile 的依赖指向具体 tgz 路径；用 `Remove-Item *.tgz` 清场
  会让下一次 `dsh plugin add` 直接 `pnpm failed`（本仓已踩两次）。要清就清**比当前版本旧**的。
- **`dsh plugin add` 需要 npm registry —— 本机它常常不可达，所以首选离线安装。**
  实测：`registry.npmjs.org` 两个端点均 HTTP 000 / 8s 超时，同刻 `raw.githubusercontent.com`
  正常 200 / 590ms。此时 `dsh plugin add` 不报错也不返回，只在 pnpm 里退避重试
  （`ETIMEDOUT` → 20s → 2min → …，5 次），在外面看就是**挂住**。
  **离线安装（首选，依赖此前都已在 store 里，实测 747ms 完成、`downloaded 0`）**：

  ```pwsh
  $prof = "$env:USERPROFILE\.dsh\profiles\web"
  $tgz  = (Resolve-Path dsh-ai-coding-<version>.tgz).Path
  # 把 profile 的依赖指向新 tarball，再离线装（等价于 plugin add 做的事，但不碰 registry）
  node -e "const fs=require('fs');const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,'utf8'));p.dependencies['dsh-ai-coding']='file:'+process.argv[2].replace(/\\/g,'/');fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$prof\package.json" $tgz
  Push-Location $prof; pnpm install --offline; Pop-Location
  ```

  注意 `dsh plugin add` 还会**更新 profile 的 `dsh.profile.bundles`**；手工改依赖时该列表通常
  已含 `dsh-ai-coding`（此前装过），若新 profile 则需自行补上。

装完核对（不要只看命令退出码）：

```pwsh
$p = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-ai-coding"
(Get-Content "$p\package.json" -Raw | ConvertFrom-Json).version   # 应等于刚打包的版本
# 并确认本次改动引入的**新字符串**确实出现在 lib/*.js 里
```

## 仓库定位

`dsh-ai-coding` —— DSH 的 AI Coding 平台插件，双半结构（host `src/*.ts` + browser `src/client/*`）。
基线 `@deepseek-ai/*@0.1.5-rc.2`。构建/测试入口见 `package.json` scripts（`typecheck` / `test` / `build`）。

## TypeSafe / Jev：**不集成进本插件**（所有者已决定）

曾经有一版把 Jev 接进召回路径的设计（"召回闸门"：检索结果进上下文前用 4 个 Noul 逐条判断），
**已按所有者要求彻底移除**：`src/recall-gate.ts`、`src/knowledge-loop.ts` 的接线、
`src/gateway.ts` 的 `recallGate` 配置段、相关测试与 `cordis.patch.yml` 注释全部删除。
**不要重新集成**，也不要因为看到设计文档就去实现它。

设计文档 `docs/typesafe-recall-gate.md` **保留为研究记录**（它记录了四个阈值、46 条语料实测、
以及官方否定 Score 的三条依据，成本约 $0.011 的四轮实验），但其中「集成路径」一节**已作废**。

TypeSafe / Jev 的用途是**给 agent 自己做判断**，不是给插件增加运行时依赖。要用它时先加载
`typesafe-ai` skill，并读官方文档（本机镜像**不含** TypeSafe 文档，见 `docs/dsh-docs-index.md` I 组）。

一条跨项目通用的事实，留在这里因为本文件早先写错过：**凭证引用要写 `credentialRef('NAME')`，不能写
`String('NAME')`** —— `CredentialRef` 是 brand 类型，后者过不了类型检查（实测 `TS2322`）。

## 文档惯例

`docs/` 下是交付物（见 `.gitignore` 中 `!docs/**/*.log` 的用意）。笔记类文档的体例：开头声明改动范围与证据强度，
带来源表格，区分「已验证」与「推断」。命名沿用 `*-notes.md` / `*-ledger.md`。
