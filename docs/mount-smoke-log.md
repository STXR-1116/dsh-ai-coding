# 挂载冒烟日志（门禁 4）

本文件归档 `build/mount-smoke.mjs` 的红/绿运行记录。脚本每一步打印 `PASS`/`FAIL`，
结束时打印唯一一行 `SMOKE GREEN|RED (n/m)`，并以退出码反映结论。

## 复现方式

```powershell
pnpm install && pnpm build
pnpm pack
dsh plugin --profile web add (Resolve-Path dsh-ai-coding-0.1.0.tgz).Path
node build/mount-smoke.mjs 7830
```

## 四个环节

| 步骤 | 断言 |
|------|------|
| boot | `dsh --profile web --no-open --port N` 起得来并打印带 token 的 URL。任何装载期硬失败（不可挂载的行、声明却不存在的子路径、重复的客户端源）都会在此暴露为超时或非零退出 |
| page | 带 token 请求 `/` 时服务端以 303 下发鉴权 cookie；跟随后渲染出 shell |
| roster | 启动图里存在 `dsh-ai-coding` 的客户端模块记录，并带有加载器将要请求的 URL |
| bundle | 该 URL 返回 200，且内容是本包的闭包工厂产物（首行 `window.__ModuleLoader__.load(`），并带上正确的包 id |

## 绿：7 次（门禁要求 ≥3）

### 绿 #1

```text
dsh web: http://127.0.0.1:7801/?token=aGDe4Pvqfunqtq3gRZ0tnweeZXrZbxwq-EC8qo6qrEg
PASS  boot: server prints its tokenized URL — port 7801
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28677 bytes
PASS  roster: boot graph registers this package as a client module — /plugins/??dsh-ai-coding/client.js&rev=2ed36d4992b476b4-51
PASS  bundle: served — HTTP 200, 488717 bytes
PASS  bundle: is this package's closure-factory artifact — first line "window.__ModuleLoader__.load({"
PASS  bundle: carries the package id
SMOKE GREEN (7/7 steps)
```

### 绿 #2

```text
dsh web: http://127.0.0.1:7821/?token=gRPOSOr-WRegM3MioVXl3hnYYlAqRHDtLPznYMzvyq4
PASS  boot: server prints its tokenized URL — port 7821
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28677 bytes
PASS  roster: boot graph registers this package as a client module — /plugins/??dsh-ai-coding/client.js&rev=978dc43e47aabe7d-51
PASS  bundle: served — HTTP 200, 488717 bytes
PASS  bundle: is this package's closure-factory artifact — first line "window.__ModuleLoader__.load({"
PASS  bundle: carries the package id
SMOKE GREEN (7/7 steps)
```

### 绿 #3

```text
dsh web: http://127.0.0.1:7822/?token=0c-yMpqAxwaQ2mHzaS5-GYQpKrmHFLAVMFUgz15V744
PASS  boot: server prints its tokenized URL — port 7822
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28677 bytes
PASS  roster: boot graph registers this package as a client module — /plugins/??dsh-ai-coding/client.js&rev=278d10e6d09bd930-51
PASS  bundle: served — HTTP 200, 488717 bytes
PASS  bundle: is this package's closure-factory artifact — first line "window.__ModuleLoader__.load({"
PASS  bundle: carries the package id
SMOKE GREEN (7/7 steps)
```

### 绿 #4

```text
dsh web: http://127.0.0.1:7823/?token=GsL-AecjamhWmAt7kXjA8vXSUt5z30VN8T4kIrKOHZg
PASS  boot: server prints its tokenized URL — port 7823
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28677 bytes
PASS  roster: boot graph registers this package as a client module — /plugins/??dsh-ai-coding/client.js&rev=84e657c7c329973f-51
PASS  bundle: served — HTTP 200, 488717 bytes
PASS  bundle: is this package's closure-factory artifact — first line "window.__ModuleLoader__.load({"
PASS  bundle: carries the package id
SMOKE GREEN (7/7 steps)
```

### 绿 #5（最终提交 bb4f6ea 重打包后）

```text
dsh web: http://127.0.0.1:7841/?token=2Ql6H8yy-Sa3Ag1HGQnTwxqX0PogqlQ45DGjdXk7boE
PASS  boot: server prints its tokenized URL — port 7841
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28677 bytes
PASS  roster: boot graph registers this package as a client module — /plugins/??dsh-ai-coding/client.js&rev=fb8100b9ae0691aa-51
PASS  bundle: served — HTTP 200, 488717 bytes
PASS  bundle: is this package's closure-factory artifact — first line "window.__ModuleLoader__.load({"
PASS  bundle: carries the package id
SMOKE GREEN (7/7 steps)
```

### 绿 #6（最终提交 bb4f6ea 重打包后）

```text
dsh web: http://127.0.0.1:7842/?token=xPUl9qU5U2HY3QIvqpDxZi8_iEcTVDUOFrsbSJw0xFo
PASS  boot: server prints its tokenized URL — port 7842
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28677 bytes
PASS  roster: boot graph registers this package as a client module — /plugins/??dsh-ai-coding/client.js&rev=208bc2200a7235bb-51
PASS  bundle: served — HTTP 200, 488717 bytes
PASS  bundle: is this package's closure-factory artifact — first line "window.__ModuleLoader__.load({"
PASS  bundle: carries the package id
SMOKE GREEN (7/7 steps)
```

### 绿 #7（最终提交 bb4f6ea 重打包后）

```text
dsh web: http://127.0.0.1:7843/?token=ivDIrLbo8mMIY8uEmgHG-KYJnqFuvo5txaYKgzPeL2g
PASS  boot: server prints its tokenized URL — port 7843
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28677 bytes
PASS  roster: boot graph registers this package as a client module — /plugins/??dsh-ai-coding/client.js&rev=706be975e33c5a2f-51
PASS  bundle: served — HTTP 200, 488717 bytes
PASS  bundle: is this package's closure-factory artifact — first line "window.__ModuleLoader__.load({"
PASS  bundle: carries the package id
SMOKE GREEN (7/7 steps)
```

## 红：1 次（证明冒烟真的能发现缺失）

做法：把 `dsh-ai-coding` 从 profile 的 `dsh.profile.bundles` 中移除后重跑。

```text
dsh web: http://127.0.0.1:7802/?token=Ri_dxJbaeZNR2aCD8tk0Y5A22uw4rurArQPk7YDE1Us
PASS  boot: server prints its tokenized URL — port 7802
PASS  page: server redirects to set its auth cookie — status 303, location /
PASS  page: shell renders with the auth cookie — 28147 bytes
FAIL  roster: boot graph registers this package as a client module — no record for dsh-ai-coding in the boot graph
smoke aborted: roster missing
SMOKE RED (3/4 steps)
```

## 结论

- 绿 7 次 / 红 1 次，满足「红/绿双日志留档、≥3 次绿方可宣布通过」。
- 红绿差异只出现在 `roster` 一步：卸载后启动图里没有本包的客户端记录，其余三步照常通过 ——
  说明该断言盯的是「本插件是否被装载」，而不是任何通用健康检查。
- 复现脚本入库：`build/mount-smoke.mjs`。

---

# 二期：真机 Chromium 断言（2026-09-21）

脚本从 7 步扩到 18 步：原 4 步（boot/page/roster/bundle）保留，新增 9 步真机
Chromium 断言（shell 挂载、无 pending 横幅、设置面出现、保存后到达登录、
登录到 ready、工作台渲染 `ws-alpha-1`、知识库渲染 `k-1`）与 fail-loud 相位
（未配置浏览器必须停在具名的设置面）。Chromium 用本机真 Chrome
（`DSH_SMOKE_BROWSER` 可覆盖），登录用 fixture 种子账号。

## 绿：连续 3 次（docs/mount-smoke/phase2/green-{1,2,3}.log）

三次全部 `SMOKE GREEN (18/18 steps)`，exit 0。关键步摘录：

```text
PASS  browser: shell mounts and the sidebar entry appears
PASS  browser: no pending banner and no boot failure banner
PASS  browser: unconfigured workbench opens the settings face
PASS  browser: saving settings reaches the account sign-in
PASS  browser: account gate turns ready after panel sign-in
PASS  browser: workbench renders fixture seed workspace ws-alpha-1
PASS  browser: knowledge view renders fixture seed k-1
PASS  fail-loud: the plugin still loads (settings face is the config channel)
PASS  fail-loud: unconfigured workbench names the missing settings loudly
SMOKE GREEN (18/18 steps)
```

## 红：1 次（受控注入，docs/mount-smoke/phase2/red-login-failure.log）

`DSH_SMOKE_PASS=wrong-password`：登录 401，账号门到不了 ready，种子断言链
按预期中断。

```text
FAIL  browser: account gate turns ready after panel sign-in — … 401 (Unauthorized)
SMOKE RED (12/13 steps)
```

调试期还出现过两次真实红灯（留此为证，完整转录未逐字存档，失败摘录如下）：
一次 16/18——云工作空间首笔读抛 `Illegal invocation`（浏览器 fetch 受体约束，
台账 D24）；修复后一次 16/18——导航点击按全等匹配失败（rail 按钮含提示文字，
改为包含匹配）。两次都以 `SMOKE RED` 结束且未被任何重试掩盖。

## 结论

- 二期验收满足：真机 Chromium 打开 dsh web → 侧边栏入口 → 设置面 → 登录 →
  工作台渲染 `ws-alpha-1`、知识库渲染 `k-1`；连续 3 绿 + 受控红留档。
- 所有者复核截图：docs/mount-acceptance/（设置面、ws-alpha-1 工作台、k-1 知识库）。

## 后记：一次未复现的红灯（2026-09-22，会话归属接线期间）

**现象**：`SMOKE RED (20/21)`，失败步骤是
`fail-loud: unconfigured workbench names the missing settings loudly — settings form: false`。
即未配置分支里，侧栏入口存在、点击也成功，但设置面没在 `BROWSER_TIMEOUT` 内出现。

**判定与处置**：

- **同一份代码复跑 GREEN 21/21**，未再复现；
- 该次运行紧跟在一次全量测试之后，机器高负载 —— 属手册所述
  **load-sensitive synchronization** 一类；
- 按测试政策，**不用"放大超时"掩盖**（那正是政策点名的掩盖手法之一），故此处只记录
  事实与复现条件，不改超时。若再出现，按阶梯复现（单跑 → 并发文件 → 多进程 → 所属门禁）
  后再定修法。

**已排除**：与夹具端口无关（bare 阶段用 `fixturePort`，不占 4100）；与当时改动无关
（设置面与云工作空间视图没有共同路径，且同一时刻全量 174 文件 / 1529 用例为绿）。
