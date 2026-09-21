# 官方 Cordis 教程（develop/cordis-tutorial）逐页忠实笔记

来源：`https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/` 及其 7 个子页，
共 8 页，全部抓取成功（HTTP 200），无页面缺失。抓取同时用英文镜像页
（`/en/develop/cordis-tutorial/...`）交叉核对了 04 与 07 两页的完整性，正文与中文页一致。

> 约定：本文档中的「规则」一律保留官方中文原句（引号内为逐字引用）。代码示例逐字照抄，未做任何改写、
> 补全或省略。官方页面上的 shell 提示符内容原样保留（例如各章重复出现的
> `node --import tsx ../../vendor/cordis/bin.js`）。凡官方页面未写的内容，本文档不补。

## 这套教程讲什么

Cordis 是 DeepSeek Harness 底层的插件框架：它是一个小型运行时，其中的每项能力，包括工具、LLM（大语言
模型）适配器、文件访问乃至 agent loop（智能体循环）本身，都是挂载到共享上下文中的插件。这套教程通过动手
实践讲解 Cordis：每一章都是一个可以运行的示例，读者在本仓库内的临时目录中逐步构建它，最后把一个插件接入
真实的 harness 服务。教程面向 agent 开发者，明确声明不需要深入掌握 TypeScript（每章给出确切命令与预期
输出），也不需要 API 密钥——「本教程不需要 API 密钥；所有示例均可在无密钥环境中运行」。7 章依次覆盖：
插件是函数并由 loader 挂载、生命周期与 effect、在 `ctx` 上提供服务并用 `inject` 依赖、类型化事件与
5 种分发模式（含 waterfall 短路）、`cordis.yml` 中经 schema 校验的配置、把配置当作插件树并做 HMR 与
PENDING 诊断、最后把工具注册进真实 harness 的 `tools` 服务。教程末尾把该启动器路径与「为 harness 本身
编写插件」区分开：后者应由 `cordis.yml` 加载、在 Web UI 中驱动，入口是 `develop/basic/`。

---

## 0. 总览页（`/develop/cordis-tutorial/`）

**页面目的**：给出 Cordis 是什么、教程的动手路线、环境准备（克隆仓库、`tmp/` 临时目录、每章同一条启动命令）、
7 章索引，以及三项 TypeScript 语法说明；同时给出定位：教程用的是「下面这个启动器」，不是为 harness 本身写插件的那条路。

### 代码示例（全部）

sh：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
```

sh：

```sh
mkdir -p tmp/cordis-tutorial
cd tmp/cordis-tutorial
```

sh（「每一章都从该目录运行同一条命令」）：

```sh
node --import tsx ../../vendor/cordis/bin.js
```

### 规范性规则与说明（逐字引用）

- 「Cordis 是 DeepSeek Harness 底层的插件框架：它是一个小型运行时，其中的每项能力，包括工具、LLM（大语言模型）适配器、文件访问乃至 agent loop（智能体循环）本身，都是挂载到共享上下文中的插件。」
- 「本教程不需要 API 密钥；所有示例均可在无密钥环境中运行。」
- 关于 `tmp/`：「`tmp/` 已被 git 忽略，因此你在其中写入的任何内容都不会进入版本控制」。
- 关于启动器：「这个单文件启动器（见 vendor/cordis/bin.js）会创建根 `Context`、挂载 Loader 插件，并让它从当前目录加载 `./cordis.yml`。其余所有内容，包括有哪些插件以及如何配置它们，都来自你稍后将编写的 YAML 文件。」
- 关于 `--import tsx`：「`--import tsx` 标志让 Node 无需构建步骤即可运行配置所指向的 TypeScript 文件。」
- 关于为 harness 本身写插件：「如果你要为 harness 本身编写插件——由 `cordis.yml` 加载、在 Web UI 中驱动，而不是下面这个启动器——请从第一个 Harness 插件开始。」

**每章的命令与目录前提**：每一章都从 `tmp/cordis-tutorial` 目录运行同一条命令 `node --import tsx ../../vendor/cordis/bin.js`。

**章节索引（逐字）**：

1. 你的第一个插件：插件是函数，由 loader 挂载。
2. 生命周期与 effect：由 Cordis 管理的注册会在所属插件卸载时撤销。
3. 服务：在 `ctx` 上公开一项能力，并通过 `inject` 依赖它。
4. 事件：类型化事件、广播分发和 waterfall（瀑布式事件）的短路行为。
5. 配置：读取 `cordis.yml` 中经过校验的配置，并在输入错误时明确报错。
6. 组合与 HMR（热模块替换）：把配置文件作为插件树，使用热重载，并诊断始终无法加载的插件。
7. 进入 harness：基于真实的 harness 服务注册一个可由模型调用的工具。

**TypeScript 说明（三项，逐字要点）**：

- 「**类型注解**描述值，但不会改变运行时行为：`ctx: Context` 表示 `ctx` 具备 Cordis 上下文 API，`who: string` 接受文本，而 `string[]` 表示字符串数组。」
- 「**`import type { Context } from '@deepseek-ai/cordis'`** 只导入类型信息。它在运行时会消失，因此仅为类型注解使用 `Context` 的插件文件不会增加运行时依赖。」
- 「**声明合并**（`declare module '@deepseek-ai/cordis' { ... }`）会为 Cordis 已经声明的接口添加你的条目，例如新 `ctx.greeter` 属性的类型或事件名称。它不会生成任何运行时接线；插件必须另行提供服务或发出事件。第 3 章会完整展示该模式。」
- 「第 5 章还会使用 `interface` 描述配置对象的字段，并使用 `Schema<Config>` 这类泛型表示 schema 校验哪些对象字段。你可以直接照写这些声明；周围的正文会解释每项声明连接了什么。」

**延伸阅读指向**：精简概念参考见 `./../../reference/cordis-primer`；详尽 API 参考见子系统页面
（`./../../reference/subsystems/core`）上生成的 `cordis-surface` 区块，以及 `Cordis 核心 API`
（`./../../reference/cordis-api/context`）页面。

---

## 1. 编写第一个插件（`/develop/cordis-tutorial/01-first-plugin`）

**页面目的**：讲清 loader 配置下插件模块的形状（命名导出 `apply`）、`name` 导出项的用途、`cordis.yml`
如何组合应用、运行后进程为何自行退出，并给出 Cordis 接受的三种插件形态与「制造错误」实验。

### 核心模型（逐字）

「在本教程使用的 loader 配置中，Cordis 插件模块通过命名导出提供 `apply` 函数。Cordis 加载模块时，会用一个
**上下文** 调用 `apply`；该上下文就是 `ctx` 对象，插件通过它注册自己贡献的所有内容。」

### 代码示例（全部）

ts —— 在 `tmp/cordis-tutorial` 目录中创建 `hello.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello'

export function apply(ctx: Context) {
  console.log('hello from my first plugin')
}
```

yaml —— 创建 `cordis.yml`：

```yaml
- name: './hello.ts'
```

sh —— 运行：

```sh
node --import tsx ../../vendor/cordis/bin.js
```

预期输出：

```
hello from my first plugin
```

ts —— 其他两种插件形态（完整示例块）：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

// 1. Function plugin (what you just wrote).
export function apply(ctx: Context) {}

// 2. Object plugin: an object with an `apply` method.
export const objectPlugin = {
  name: 'object-plugin',
  apply(ctx: Context) {},
}

// 3. Class plugin: a Service subclass (covered in chapter 3).
export class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myTutorialService')
  }
}
```

ts —— 「尝试制造错误」：让 `apply` 抛出异常：

```ts
export function apply(ctx: Context) {
  throw new Error('apply exploded')
}
```

### 规范性规则（逐字引用）

- 关于 `name`：「`name` 导出项是可选的显示元数据；它用于在诊断信息中标识插件。」
- 关于 `cordis.yml`：「该文件是一组 Cordis 配置项的列表。`name` 是模块指定符，可以是相对路径或 NPM 包名；loader 会挂载每个配置项。」
- **顺序规则（关键）**：「各项会并发启动，因此它们在列表中的位置不保证插件的加载先后；顺序由服务依赖（`inject`，参见第 3 章）决定，而非文件中的位置。」
- 进程退出：「当没有任何内容继续运行时，进程会自行退出。」
- 启动三步（逐字）：
  1. 「启动器创建根 `Context`，并挂载 **Loader** 插件。」
  2. 「Loader 读取 `cordis.yml`，解析 `./hello.ts`，然后将其作为子插件挂载。」
  3. 「Cordis 调用你的 `apply(ctx)`。」
- 关于组合的应用：「你的文件中没有框架启动代码：插件描述自己的贡献，`cordis.yml` 则组合应用。」
- 关于三种形态：「在你需要公开服务之前，请一直使用函数形态；第 3 章介绍了何时应当使用类形态。」
- **失败语义（关键）**：「再次运行：进程会因该错误而终止。插件加载失败会明确报错，不会仅跳过该配置项。」
- **例外（解析失败）**：「还需要尽早了解一个例外：如果某个配置项的模块无法被 **解析**，例如路径或包名拼写错误，Cordis 会通过 logger 服务报告错误，而不会使进程崩溃。在启动阶段，这条报告可能在 console 导出器开始观察之前丢失。如果新增配置项似乎没有任何效果，请先检查拼写。」

**示例（官方举例）**：`dsh` base（`packages/bundle/base/cordis.patch.yml`）就是一份更长的插件组合，由部署
overlay 对它进行修补。

---

## 2. 生命周期与 effect（`/develop/cordis-tutorial/02-lifecycle-and-effects`）

**页面目的**：说明插件会因何卸载、哪些注册已自动属于 effect、何时必须用 `ctx.effect()` 包装资源、fiber 状态机、
以及 disposer 的顺序与并发注意事项。

### 核心模型（逐字）

「Cordis 插件可能因修改配置、热重载、显式资源释放或所需服务消失而卸载。通过 Cordis API 建立的注册属于
effect，会在所属插件卸载时撤销；在这些 API 之外管理的资源必须包装在 `ctx.effect()` 中。」

### 代码示例（全部）

ts —— 创建 `lifecycle.ts`，放在 `tmp/cordis-tutorial` 中：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'lifecycle-demo'

function heartbeat(ctx: Context) {
  console.log('heartbeat plugin loading')
  ctx.effect(() => {
    const timer = setInterval(() => console.log('tick'), 200)
    return () => {
      clearInterval(timer)
      console.log('heartbeat cleaned up')
    }
  })
}

export function apply(ctx: Context) {
  // Mount a child plugin and keep its fiber to dispose it later.
  const fiber = ctx.plugin(heartbeat)
  // The demo timer is itself an effect: if THIS plugin is unloaded first,
  // the pending callback is cancelled instead of firing on a dead app.
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      await fiber.dispose()
      console.log('disposed')
      process.exit(0)
    }, 700)
    return () => clearTimeout(timer)
  })
}
```

yaml —— 让 `cordis.yml` 指向该文件：

```yaml
- name: './lifecycle.ts'
```

运行（`node --import tsx ../../vendor/cordis/bin.js`）后会得到：

```
heartbeat plugin loading
tick
tick
tick
heartbeat cleaned up
disposed
```

纯文本 —— Fiber 状态机：

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

### 规范性规则（逐字引用）

- 前言句：「对于 Cordis 尚未管理的资源，例如定时器、连接或 watcher，应将其包装在 `ctx.effect()` 中并返回 disposer（资源释放函数）」。
- 关于 `ctx.plugin(heartbeat)`：「`ctx.plugin(heartbeat)` 会把一个**来自代码**的函数挂载为插件，这与 YAML loader 为每个配置项执行的操作相同。函数插件不需要 `apply` 方法：Cordis 会直接调用该函数，其名称只用于诊断。只有对象形态才要求 `apply` 方法，例如 `ctx.plugin({ apply(ctx) { /* ... */ } })`。调用会返回一个 **fiber**，即一个已加载插件实例的运行时句柄。」
- 关于 effect 时序：「effect 主体在加载期间运行；它返回的 disposer 在卸载期间运行。对于生命周期与插件一致的资源，你绝不需要自行调用 disposer。」
- 关于 `fiber.dispose()`：「`fiber.dispose()` 会等该插件的所有清理工作（包括异步 disposer）完成后才结束，并递归卸载它挂载的所有子插件。」
- 状态机语义（逐字）：
  - 「**PENDING**：已经声明，但所需服务（第 3 章）尚不可用。」
  - 「**LOADING / ACTIVE**：`apply` 正在运行／已经完成。」
  - 「**FAILED**：`apply` 或配置校验抛出异常。」
  - 「**UNLOADING / DISPOSED**：disposer 正在运行／一切均已拆除。」
  - 「你会在第 6 章再次遇到 PENDING，它通常就是「为什么我的插件没有输出」的答案。」
- 已经属于 effect 的操作（逐字）：
  - 「你很少需要亲自编写 `ctx.effect()`，因为内置注册 API 本身已经是 effect：」
  - 「`ctx.on(event, listener)`：监听器会在卸载时移除（第 4 章）。」
  - 「`ctx.plugin(child)`：子插件会随父插件一同 dispose（资源释放）。」
  - 「服务注册属于 effect。`ctx.tools.register(...)` 等 harness 注册表也会把返回的 disposer 附着到调用插件上，因此会自动撤销（第 7 章）。」
- 通用要求：「对于 Cordis 不管理的资源，应在 `ctx.effect()` 内获取它，并返回用于释放资源的 disposer。此后 Cordis 会在卸载期间调用该释放逻辑，热重载时也不例外。」
- **顺序注意事项（关键，逐字）**：「有一项顺序注意事项：disposer 会按注册顺序的逆序启动，但多个**异步** disposer 会并发运行。如果拆除步骤必须按顺序执行，请把它们放在同一个 disposer 中，并在其中依次等待每步完成。」

### 默认值与顺序保证汇总

- 顺序保证：disposer 按**注册顺序的逆序**启动。
- 并发保证：多个异步 disposer **并发**运行。
- 补救手段：需要严格顺序时，把步骤放进**同一个 disposer** 并依次 `await`。

---

## 3. 服务（`/develop/cordis-tutorial/03-services`）

**页面目的**：定义「服务」概念、演示如何用 `Service` 子类提供服务（运行时注册 + 编译时声明合并两部分）、
如何用 `inject` 消费、依赖在加载后仍被跟踪的后果、可选依赖的写法，以及服务命名空间纪律。

### 核心模型（逐字）

「**服务**是一个插件提供、其他插件通过 `ctx` 消费的具名能力。在 harness 中，`ctx.tools`、`ctx.llm` 和
`ctx.agents` 都是服务。消费方只指定 `'tools'` 之类的能力，而不导入其提供方，因此配置可以选择提供方，
无需修改消费方。」

### 代码示例（全部）

ts —— 创建 `greeter.ts`，放在 `tmp/cordis-tutorial` 中：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string) {
    return `Hello, ${who}!`
  }
}

export const name = 'greeter'

export function apply(ctx: Context) {
  ctx.plugin(GreeterService)
}
```

ts —— 创建 `consumer.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'consumer'
export const inject = ['greeter']

export function apply(ctx: Context) {
  console.log(ctx.greeter.greet('world'))
}
```

yaml —— 组合并运行：

```yaml
- name: './greeter.ts'
- name: './consumer.ts'
```

输出：

```
Hello, world!
```

ts —— 可选依赖（「如果某项功能缺失时插件仍可运行，请跳过 `inject`，并在使用处探测」）：

```ts
export function apply(ctx: Context) {
  // undefined when no provider is loaded; the plugin still runs.
  const greeter = ctx.get('greeter')
  console.log(greeter?.greet('maybe') ?? 'no greeter available')
}
```

### 规范性规则（逐字引用）

- 两部分协同工作（逐字）：
  - 「**运行时**：`super(ctx, 'greeter')` 以名称 `greeter` 注册该实例。此后，任何插件都可以通过 `ctx.greeter` 访问它。注册属于 effect，卸载提供方时会移除该服务。」
  - 「**编译时**：`declare module '@deepseek-ai/cordis'` 块使用 TypeScript 声明合并，把 `greeter` 加入 `Context` 接口，使 `ctx.greeter` 在各处都能通过类型检查。它不会生成代码；没有该声明时，服务在运行时仍能工作，但消费方会失去类型安全。」
- 类形态即插件：「`Service` 子类本身就是插件（第 1 章介绍的类形态），因此 `ctx.plugin(GreeterService)` 会像挂载其他插件一样挂载它。」
- **inject 语义（关键）**：「`inject` 列出该插件需要的服务。Cordis 会让插件保持 PENDING，直到列出的每项服务都存在，因此在 `apply` 内可以保证 `ctx.greeter` 已经就绪。」
- **顺序（关键）**：「`cordis.yml` 中的加载顺序无关紧要：决定插件何时启动的是依赖关系，而不是文件顺序。」「交换 `cordis.yml` 中两行的顺序后重新运行，输出仍然相同。」
- **缺提供方的行为（关键）**：「尝试彻底移除 `./greeter.ts`：消费方会保持 PENDING，不输出任何内容，既不崩溃，也不会只运行一部分。处于 PENDING 的 fiber 也不会让 Node 的事件循环保持活跃，因此如果组合中没有其他运行项，进程会静默地以状态码 0 退出。第 6 章介绍如何诊断这种状态。」
- **依赖在加载后持续跟踪（关键）**：「`inject` 并非一次性的启动检查。如果应用运行期间所需服务消失，例如提供方被卸载或热替换，每个依赖插件也会随之卸载，并在服务恢复后再次加载。结合 effect（第 2 章），这能防止运行中的消费方保留对不可用服务的引用：依赖消失时，它自己的注册也会撤销。」
- 可替换性：「这也是配置中可以替换服务的原因：卸载 Cordis 配置项 `dsh-bash-local`，挂载另一个 `shell` 提供方，所有注入 `'shell'` 的插件都会重新启动并使用新实现。」
- 可选依赖：「`inject` 用于硬性依赖。如果某项功能缺失时插件仍可运行，请跳过 `inject`，并在使用处探测」。
- **命名纪律（关键）**：「每个应用中的服务名称共用一个扁平命名空间。请为自有服务添加有辨识度的前缀或命名空间（harness 已占用 `tools` 和 `llm` 等普通名称）；子系统页面上生成的 `cordis-surface` 区块列出 harness 注册的每个名称。」

---

## 4. 事件（`/develop/cordis-tutorial/04-events`）

**页面目的**：讲事件与服务的分工、声明合并 `interface Events`、`ctx.on` 的 effect 语义、5 种分发模式对照表、
waterfall 的转换与短路（含「只观察必须调用 `next()`」纪律），以及 harness 中用到 waterfall 的两个真实事件。

### 核心模型（逐字）

「服务支持直接调用；**事件**让插件无需知道有哪些插件正在监听，就能发出通知。harness 使用事件处理工具结果、
模型请求和审批决定等交互。」

### 代码示例（全部）

ts —— 创建 `stats.ts`，放在 `tmp/cordis-tutorial` 中（「它是一项负责计数并在每次变化时发出通知的服务」）：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    stats: StatsService
  }
  interface Events {
    'stats/report'(name: string, count: number): void
  }
}

export class StatsService extends Service {
  private counts = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'stats')
  }

  bump(name: string) {
    const next = (this.counts.get(name) ?? 0) + 1
    this.counts.set(name, next)
    this.ctx.emit('stats/report', name, next)
  }
}

export const name = 'stats'

export function apply(ctx: Context) {
  ctx.plugin(StatsService)
}
```

ts —— 创建 `reporter.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from './stats.ts'

export const name = 'reporter'
export const inject = ['stats']

export function apply(ctx: Context) {
  ctx.on('stats/report', (name, count) => {
    console.log(`[stats] ${name} -> ${count}`)
  })
  ctx.stats.bump('tool_call')
  ctx.stats.bump('tool_call')
  ctx.stats.bump('prompt')
}
```

yaml —— 组合并运行：

```yaml
- name: './stats.ts'
- name: './reporter.ts'
```

输出：

```
[stats] tool_call -> 1
[stats] tool_call -> 2
[stats] prompt -> 1
```

表格 —— 分发模式（5 种，逐字）：

| 模式 | 调用 | 语义 |
| --- | --- | --- |
| emit | `ctx.emit(name, ...args)` | 同步广播；不会等待或收集返回的 promise 与值。 |
| parallel | `await ctx.parallel(name, ...args)` | 所有监听器并发运行，并一同等待。 |
| serial | `await ctx.serial(name, ...args)` | 监听器按顺序运行并等待；第一个非 `null`/`false`/`undefined` 返回值胜出，并停止后续监听器。 |
| bail | `ctx.bail(name, ...args)` | serial 的同步版本。 |
| waterfall（瀑布式事件） | `ctx.waterfall(name, ...args, next)` | 环绕中间件，见下文。 |

ts —— 创建 `waterfall-demo.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'demo/transform'(input: string, next: () => Promise<string>): Promise<string>
  }
}

export const name = 'waterfall-demo'

export function apply(ctx: Context) {
  // Listener 1: wrap the downstream result.
  ctx.on('demo/transform', async (input, next) => {
    const downstream = await next()
    return downstream.toUpperCase()
  })

  // Listener 2: short-circuit when it owns the decision.
  ctx.on('demo/transform', async (input, next) => {
    if (input.includes('blocked')) return '** blocked **'
    return next()
  })

  void (async () => {
    console.log(await ctx.waterfall('demo/transform', 'hello', async () => 'hello'))
    console.log(await ctx.waterfall('demo/transform', 'blocked words', async () => 'blocked words'))
  })()
}
```

让 `cordis.yml` 只指向该文件并运行：

```
HELLO
** BLOCKED **
```

### 规范性规则（逐字引用）

- 声明合并：「`interface Events` 合并与第 3 章的 `interface Context` 合并在事件系统中相互对应：它声明事件名称及其监听器签名，因此 `ctx.emit` 和 `ctx.on` 都具有完整类型。`namespace/action` 命名约定让扁平的事件命名空间保持易读。」
- 关于 `import type {}`：「`import type {} from './stats.ts'` 行不会在运行时导入任何内容；它的作用是让 TypeScript 看到声明合并。」
- **监听器清理（关键）**：「因为 `ctx.on()` 属于 effect，监听器会随插件一同消失，绝不需要手动维护 `removeListener`。」
- 分发模式契约：「`emit` 是 5 种分发模式之一。事件采用哪种模式是其约定的一部分，决定了监听器能否返回值、能否并发运行，以及能否彼此短路」。
- 模式文档位置：「每个 harness 事件都会在其所属子系统页面自动生成的参考文档中记录其模式。」
- waterfall 定义：「waterfall 是实现拦截的模式。每个监听器都会收到参数和一个 `next()` continuation；它可以转换 `next()` 的返回值，也可以不调用 `next()` 就直接返回，从而短路链条的其余部分。Cordis 文档把后一种行为称为否决。」
- waterfall 执行顺序（逐字走查）：「按顺序看第二行如何产生：监听器 1 先运行并调用 `next()`，从而调用监听器 2；监听器 2 看到 `blocked` 后直接返回而不调用 `next()`，因此最内层默认逻辑（传给 `ctx.waterfall` 的函数）从未运行；返回途中，监听器 1 再把替换消息转换为大写。」
- **常设纪律（关键，逐字）**：「由此得到一项纪律：**只负责观察或标注的 waterfall 监听器必须调用 `next()`**；不调用就直接返回代表有意短路。如果日志监听器忘记调用 `next()`，会悄无声息地吞掉所有下游的默认行为。这是本仓库的常设规则（waterfall 语义）。」
- harness 中的 waterfall 用例（逐字）：「harness 使用 waterfall 处理协作插件可以包装或回答的决策：`agent/request` 允许插件替换模型调用配置，`approval/request` 允许策略代替用户作答。」

---

## 5. 配置（`/develop/cordis-tutorial/05-config`）

**页面目的**：讲 `cordis.yml` 每个配置项的 `config` 块、插件用 schema 在 `apply` 前校验、错误配置的响亮失败与
`ValidationError` 形态，以及本仓库 loader 的 `!!js` 计算值标签及其适用范围。

### 核心模型（逐字）

「`cordis.yml` 中的每个 Cordis 配置项都可以携带 `config` 块，插件则声明一个 schema，在运行 `apply` 前验证
该块。错误配置会导致加载失败，并给出准确的错误：插件绝不会在配置不完整时启动。」

### 代码示例（全部）

ts —— 创建 `config-demo.ts`，并将其放在 `tmp/cordis-tutorial` 中：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'config-demo'

export interface Config {
  greeting: string
  targets: string[]
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['world']),
})

export function apply(ctx: Context, config: Config) {
  for (const target of config.targets) {
    console.log(`${config.greeting}, ${target}!`)
  }
}
```

yaml —— 对其进行配置：

```yaml
- name: './config-demo.ts'
  config:
    targets: ['alpha', 'beta']
```

运行：

```
Hello, alpha!
Hello, beta!
```

yaml —— 现在向它传入无效内容：

```yaml
- name: './config-demo.ts'
  config:
    targets: 'not-an-array'
```

```
ValidationError: invalid config:
  - $.targets expected array but got not-an-array (at targets)
```

yaml —— 计算得到的配置值（`!!js`）：

```yaml
- name: './config-demo.ts'
  config:
    greeting: !!js process.env.DEMO_GREETING ?? 'Hello'
```

### 规范性规则与默认值（逐字引用）

- schema 双身份：「导出的 `Config` 既是 TypeScript 接口，也是同名的运行时 schema：消费方获得类型，Cordis 获得验证器。」
- schema 实现约束（关键）：「本仓库使用 Schemastery 定义 schema；Cordis 本身接受任意 Standard Schema 验证器，因此将普通对象导出为 `Config` 无法工作。」
  - 相关链接：Schemastery `https://github.com/shigma/schemastery`；Standard Schema `https://standardschema.dev/`。
- **默认值（关键）**：「未提供 `greeting`，因此 schema 默认值会将其补齐：`apply` 始终会收到完整且经过验证的配置。」
  - 声明的默认值（逐字来自代码）：`greeting` 默认 `'Hello'`；`targets` 默认 `['world']`。
- **错误配置语义（关键）**：「插件的 fiber 进入 FAILED 状态，本教程的启动器打印错误后以状态码 1 退出。如果某个插件的配置通过了 schema 验证，但其中指定的资源或提供方不可用，该插件也应当在能解析该引用时立即拒绝。」
- `!!js` 适用范围（关键，逐字）：「本仓库使用的 loader 支持 `!!js` 标签，用于必须在加载时计算的配置值」；
  「`!!js` 仅在 `config` 与条目 `disabled` 字段内有效。`disabled: !!js ...` 在每次挂载决策时基于 loader 上下文求值（本仓库的扩展），可以按平台或环境门控一行；其余元数据（`name`、`id`、`inject` 等）保持静态，其中的表达式是普通真值数据。详见 loader 配置。」
- 章节定位：「下一章：组合与 HMR（热模块替换）：将 `cordis.yml` 视为应用。」

---

## 6. 组合与 HMR（热模块替换）（`/develop/cordis-tutorial/06-composition-and-hmr`）

**页面目的**：把 `cordis.yml` 当作插件树来改：讲 `id`、`disabled`、组与 `isolate`，演示 HMR 的卸载再加载过程，
并给出诊断 PENDING 插件的可运行代码。

### 核心模型（逐字）

「到目前为止构建的每项能力都是插件，`cordis.yml` 则选择应用的插件树。本章会改变这种组合、热重载一个插件，
并诊断始终无法加载的插件。」

### 代码示例（全部）

yaml —— Cordis 配置项不只有名称：

```yaml
- id: greeter          # stable identity for this entry
  name: './greeter.ts'
- id: consumer
  name: './consumer.ts'
  disabled: true       # keep the entry, skip mounting it
```

yaml —— 在 `tmp/cordis-tutorial` 中编写 `cordis.yml`（HMR 组合）：

```yaml
- id: logger
  name: '@deepseek-ai/cordis-plugin-logger-console'
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root: ['.']
- id: hello
  name: './hello.ts'
```

sh —— 「HMR 通过 Loader 的原生辅助工具读取 Node 的 loader 内部结构。请在 tsx 下运行 Cordis：」

```sh
node --import tsx ../../vendor/cordis/bin.js
```

编辑 `hello.ts` 后的输出：

```
hello from my first plugin
2026-07-22 15:44:36 [I] hmr watching [ '.' ]
2026-07-22 15:44:39 [I] hmr reload plugin at hello.ts
hello from my EDITED plugin
```

ts —— 创建 `diagnose.ts`：

```ts
import { FiberState, type Context } from '@deepseek-ai/cordis'

export const name = 'diagnose'

export function apply(ctx: Context) {
  setTimeout(() => {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.state === FiberState.PENDING) {
          console.log(`${fiber.name} is PENDING — a required service is missing`)
        }
      }
    }
  }, 500)
}
```

ts —— 再创建一个依赖无法满足的插件 `needs-timer.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'needs-timer'
export const inject = ['timer']

export function apply(ctx: Context) {
  console.log('needs-timer loaded')
}
```

yaml：

```yaml
- name: './needs-timer.ts'
- name: './diagnose.ts'
```

运行它（直接执行 `node --import tsx ../../vendor/cordis/bin.js`，按 Ctrl-C 停止）：

```
needs-timer is PENDING — a required service is missing
```

### 规范性规则与语义（逐字引用）

- **`id` 的语义（关键）**：「`id` 为 Cordis 配置项提供稳定标识，使 loader 能区分修改现有 Cordis 配置项与先删除再添加。」
- **无 `id` 的后果（关键，逐字）**：「这就是上述 Cordis 配置项显式携带 `id` 的原因：不带该字段的 Cordis 配置项在每次读取时都会获得一个新生成的 id，所以只要配置文件发生任何编辑，即使自身文本未变，它也会被视为先删除再添加并重新挂载。」
- **`disabled` 语义（关键，逐字）**：「`disabled: true` 会卸载插件而不删除其 Cordis 配置项；改回原值后，插件以及所有因依赖其服务而处于 PENDING 的插件都会再次加载。」
- **组与 isolate（逐字）**：「组可以嵌套一份 Cordis 配置项子列表，并将其作为一个单元加载和卸载；`isolate` 则为一个组提供某项服务名称的独立实例，因此两个组可以各自看到配置不同的 `shell` 提供方，互不影响。Cordis 入门和服务隔离示例介绍了详细内容。」
- HMR 原理（逐字）：「卸载会释放 effect（第 2 章），加载则遵循依赖关系（第 3 章），因此 HMR 可以先卸载、再加载，以替换正在运行的插件。`@deepseek-ai/cordis-plugin-hmr` 插件会监视文件，并在保存时执行这一过程。」
- **辅助插件的两个隐藏依赖（关键，逐字）**：「列表中增加了两个辅助插件：HMR 通过 Cordis logger 服务记录日志，因此没有控制台导出器时看不到其消息；它还会 `inject` `timer` 服务来实现去抖，如果没有 `@deepseek-ai/cordis-plugin-timer`，它就会永远停在 PENDING，而且不发出任何提示。下一节就讨论这种静默状态。」
- HMR 运行前提：「HMR 通过 Loader 的原生辅助工具读取 Node 的 loader 内部结构。请在 tsx 下运行 Cordis」。
- **替换过程（逐字）**：「旧实例先卸载（其所有 effect 都会回卷），新代码随后加载，`apply` 再次运行。按 Ctrl-C 停止进程。」
- **配置编辑的增量语义（关键，逐字）**：「编辑 `cordis.yml` 本身也会触发更新：loader 按 `id` 比较 Cordis 配置项，只挂载、卸载或重新配置发生变化的部分。」
- **PENDING 是合法状态（关键，逐字）**：「依赖驱动加载也有另一面：如果插件的 `inject` 指定了无人提供的服务，它就会一直等待，不输出任何内容。这不是错误，因为 PENDING 是合法状态，提供方可能稍后才挂载。」
- 诊断手段：「你可以直接查看这些状态。每个上下文都能枚举插件注册表；创建 `diagnose.ts`：」；随后「`inject: ['timer']` 没有提供方。向列表添加 `- name: '@deepseek-ai/cordis-plugin-timer'` 后，插件就会加载。如果插件既不执行任何操作，也不报告任何内容，请检查其 fiber 状态。」
- **注册表枚举的补充现象（逐字）**：「不加 PENDING 过滤条件进行迭代时，还会看到 loader 自身的插件（Loader、Include）处于 ACTIVE，因为配置文件本身也是通过插件挂载的。」

---

## 7. 进入 harness（`/develop/cordis-tutorial/07-into-the-harness`）

**页面目的**：把前六章的模式用到真实 harness 服务上：向 `tools` 服务注册一个模型可调用的工具、用独立观察插件
监听 `tools/result`、组合运行，并指出通往完整 agent 的路径。

### 核心模型（逐字）

「本章会向 harness 的 `tools` 服务注册一个可由模型调用的工具，通过 harness 工具流水线执行它，并观察结果事件。
整个示例无需密钥，也不会调用模型。」

### 代码示例（全部）

ts —— 创建 `greet-tool.ts`，将它放在 `tmp/cordis-tutorial` 中：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet the named person.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))

  // Drive one call through the real execution pipeline, standing in for
  // the model. ToolCallId brands the correlation id a provider would issue.
  void (async () => {
    const result = await ctx.tools.execute({
      callId: brandString<ToolCallId>('demo-1'),
      name: 'greet',
      arguments: { name: 'Cordis' },
      signal: new AbortController().signal,
    })
    console.log('tool replied:', JSON.stringify(result.content))
  })()
}
```

ts —— 创建 `tool-logger.ts`（「这是一个独立插件，通过 harness 的 `tools/result` 事件观察应用中的每次工具调用」）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'tool-logger'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    console.log(`[tool-logger] ${exec.name} -> ${text}`)
  })
}
```

yaml —— 组合并运行：

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: './tool-logger.ts'
- name: './greet-tool.ts'
```

sh：

```sh
node --import tsx ../../vendor/cordis/bin.js
```

输出：

```
[tool-logger] greet -> Hello, Cordis!
tool replied: [{"type":"text","text":"Hello, Cordis!"}]
```

### 规范性规则与顺序保证（逐字引用）

- 模式来自前几章（逐字）：「这里的每个模式都来自前几章：`inject: ['tools']`（第 3 章）会让插件等待工具注册表就绪；`ctx.tools.register(...)` 会把注册 disposer 附着到插件（第 2 章），因此卸载时会注销工具。」
- `defineTool` 契约（逐字）：「`defineTool` 将 `parameters` 规约转换为向模型展示的 JSON Schema，推导 `args` 的类型，并在 `execute` 运行前校验模型提供的参数。工具返回由 `output.schema` 声明的规范值；`output.render` 则作为 Native renderer（原生渲染器），另行生成可持久化的结果内容。」
- 包级声明合并（逐字）：「`import type {} from '@deepseek-ai/dsh-tools'` 行会引入该包的声明合并，使 `'tools/result'` 及其 payload 具有类型。这与第 4 章导入 `stats.ts` 的做法相同，只是扩展到了包级别。」
- **组合中的隐藏依赖（关键，逐字）**：「`@deepseek-ai/dsh-tools` 会注入 `systemPrompt` 服务，因为工具需要向系统提示词贡献 schema，所以组合中也要列出该服务的提供方。缺少提供方时，工具插件会像第 6 章所述那样保持 PENDING。」
- **事件顺序保证（关键，逐字）**：「logger 会先触发：`tools/result` 在结果物化过程中发出，发生在 `execute` 向调用方返回的 promise 兑现之前。两个插件都不知道另一个插件存在，它们由注册表服务和事件连接。」
- 由此走向完整 agent（逐字）：「真实 agent 就是这套组合再加上更多插件：LLM（大语言模型）适配器、agent loop（智能体循环）、持久化和应用入口。对照 base profile 层与 headless 层，你现在已经可以读懂其中各项。通过一个小型 `--patch` overlay 加入 `greet-tool.ts` 即可。」
  - 链接：`packages/bundle/base/cordis.patch.yml`、`packages/bundle/headless/cordis.patch.yml`。
- 后续阅读：构建工具（`./../basic/tool`，深入了解 `defineTool`，包括呈现和更丰富的 schema）、三层能力设计
  （`./../practice/`）、子系统页面上的 `cordis-surface` 区块、架构（`./../../reference/`）。

---

## 跨页规则与陷阱

以下条目均在教程中出现过（含重复出现的常设规则），按主题汇总；括号内为出处章节。

### 1. 合法插件形态（第 1 章）

- 三种形态：**函数插件**（命名导出 `apply`）、**对象插件**（带 `apply` 方法的对象）、**类插件**（`Service` 子类）。
- 「函数插件不需要 `apply` 方法：Cordis 会直接调用该函数，其名称只用于诊断。只有对象形态才要求 `apply` 方法」。
- 「在你需要公开服务之前，请一直使用函数形态」。
- `name` 导出项是**可选**的显示元数据，仅用于诊断；`inject` 也是导出的元数据（第 3 章）。
- 插件模块内**不含框架启动代码**：插件只描述自己的贡献，应用由 `cordis.yml` 组合。

### 2. 加载顺序 ≠ 文件顺序（第 1、3、6 章）

- 「各项会并发启动，因此它们在列表中的位置不保证插件的加载先后；顺序由服务依赖（`inject`）决定，而非文件中的位置。」
- 「`cordis.yml` 中的加载顺序无关紧要：决定插件何时启动的是依赖关系，而不是文件顺序。」交换两行顺序输出相同。

### 3. 失败与静默的两条不同路径（第 1、5、6 章）

- `apply` 抛出异常 / 配置校验失败 → 进程终止或 fiber 进入 FAILED 并响亮报错；「插件加载失败会明确报错，不会仅跳过该配置项」。
- **模块解析失败**（路径或包名拼写错误）→ 走高另一条路：「Cordis 会通过 logger 服务报告错误，而不会使进程崩溃。在启动阶段，这条报告可能在 console 导出器开始观察之前丢失。如果新增配置项似乎没有任何效果，请先检查拼写。」
- 配置校验失败的完整链路：fiber 进入 FAILED，启动器打印 `ValidationError: invalid config: ...` 后「以状态码 1 退出」。
- **静默的第三种**：`inject` 无人提供 → PENDING，不输出、不崩溃，「PENDING 是合法状态，提供方可能稍后才挂载」。

### 4. PENDING 与诊断（第 2、3、6 章）

- PENDING 含义：「已经声明，但所需服务尚不可用」。第 2 章预告：「你会在第 6 章再次遇到 PENDING，它通常就是「为什么我的插件没有输出」的答案。」
- 「处于 PENDING 的 fiber 也不会让 Node 的事件循环保持活跃，因此如果组合中没有其他运行项，进程会静默地以状态码 0 退出。」
- 诊断代码路径：`ctx.registry.values()` → `runtime.fibers` → `fiber.state === FiberState.PENDING`（`FiberState` 从 `@deepseek-ai/cordis` 导入）。
- 不加过滤迭代时会看到 Loader、Include 处于 ACTIVE，「因为配置文件本身也是通过插件挂载的」。
- 辅助插件自身也会 PENDING：HMR「会 `inject` `timer` 服务来实现去抖，如果没有 `@deepseek-ai/cordis-plugin-timer`，它就会永远停在 PENDING，而且不发出任何提示」；HMR 无 logger 控制台导出器时「看不到其消息」。

### 5. 清理、effect 与 disposer 顺序（第 2、3、4、7 章）

- 卸载触发原因：「修改配置、热重载、显式资源释放或所需服务消失」。
- 通过 Cordis API 建立的注册**自动**属于 effect，卸载时撤销：`ctx.on` 监听器、`ctx.plugin(child)` 子插件、服务注册、
  `ctx.tools.register(...)` 等 harness 注册表（返回的 disposer 附着到调用插件）。
- 非 Cordis 管理的资源（定时器、连接、watcher）**必须**包装在 `ctx.effect()` 中并返回 disposer。
- 「effect 主体在加载期间运行；它返回的 disposer 在卸载期间运行。对于生命周期与插件一致的资源，你绝不需要自行调用 disposer。」
- **顺序陷阱**：「disposer 会按注册顺序的逆序启动，但多个**异步** disposer 会并发运行。如果拆除步骤必须按顺序执行，请把它们放在同一个 disposer 中，并在其中依次等待每步完成。」
- `fiber.dispose()` 的保证：「会等该插件的所有清理工作（包括异步 disposer）完成后才结束，并递归卸载它挂载的所有子插件。」
- HMR 下同样生效：「Cordis 会在卸载期间调用该释放逻辑，热重载时也不例外」；「旧实例先卸载（其所有 effect 都会回卷），新代码随后加载，`apply` 再次运行」。
- 「因为 `ctx.on()` 属于 effect，监听器会随插件一同消失，绝不需要手动维护 `removeListener`。」

### 6. 服务与依赖（第 3、7 章）

- 服务注册是 effect：卸载提供方即移除服务；「服务子类本身就是插件」。
- `inject` 是**硬性依赖**且**持续生效**：「`inject` 并非一次性的启动检查」；提供方消失 → 依赖插件随之卸载；服务恢复 → 再次加载；
  「结合 effect，这能防止运行中的消费方保留对不可用服务的引用：依赖消失时，它自己的注册也会撤销」。
- 可选依赖：跳过 `inject`，用 `ctx.get('greeter')` 在使用处探测（无提供方时返回 `undefined`，插件仍运行）。
- 声明合并只提供类型、不生成接线；没有它「服务在运行时仍能工作，但消费方会失去类型安全」。
- **命名陷阱**：「每个应用中的服务名称共用一个扁平命名空间」，harness 已占用 `tools`、`llm` 等普通名称，自有服务要加前缀；
  权威清单在子系统页面的 `cordis-surface` 区块。
- 替换实现的方式：卸载 `dsh-bash-local`，挂载另一个 `shell` 提供方，所有注入 `'shell'` 的插件重新启动并使用新实现。

### 7. 事件与 waterfall（第 4、7 章）

- 5 种模式：`emit`（同步广播，不等待/不收集 promise 与值）、`parallel`（并发并一同等待）、
  `serial`（按顺序并等待，第一个非 `null`/`false`/`undefined` 返回值胜出并停止后续）、`bail`（serial 的同步版本）、
  `waterfall`（环绕中间件）。「事件采用哪种模式是其约定的一部分」，且每个 harness 事件在其所属子系统页面记录模式。
- 命名约定：`namespace/action`（如 `stats/report`、`tools/result`、`agent/request`、`approval/request`）。
- **waterfall 常设纪律**：「**只负责观察或标注的 waterfall 监听器必须调用 `next()`**；不调用就直接返回代表有意短路。
  如果日志监听器忘记调用 `next()`，会悄无声息地吞掉所有下游的默认行为。这是本仓库的常设规则。」
- waterfall 定义：监听器可转换 `next()` 的返回值，也可不调用 `next()` 直接返回（Cordis 文档称之为**否决**）；
  不调用 `next()` 时「最内层默认逻辑（传给 `ctx.waterfall` 的函数）从未运行」。
- **事件顺序保证（第 7 章）**：`tools/result`「在结果物化过程中发出，发生在 `execute` 向调用方返回的 promise 兑现之前」，
  因此 logger 输出先于 `execute` 的返回打印。

### 8. `cordis.yml` 元数据、`id`、`disabled`、组、`isolate`（第 5、6 章）

- 配置项字段：`name`（模块指定符，相对路径或 NPM 包名）、`config`（可选配置块）、`id`、`disabled`。
- **`id` 稳定性陷阱**：「不带该字段的 Cordis 配置项在每次读取时都会获得一个新生成的 id，所以只要配置文件发生任何编辑，
  即使自身文本未变，它也会被视为先删除再添加并重新挂载。」（HMR 因此建议显式写 `id`。）
- loader 更新粒度：「loader 按 `id` 比较 Cordis 配置项，只挂载、卸载或重新配置发生变化的部分。」
- **`disabled` 语义**：「`disabled: true` 会卸载插件而不删除其 Cordis 配置项；改回原值后，插件以及所有因依赖其服务而处于
  PENDING 的插件都会再次加载。」
- **组**：「组可以嵌套一份 Cordis 配置项子列表，并将其作为一个单元加载和卸载」。
- **`isolate`**：「`isolate` 则为一个组提供某项服务名称的独立实例，因此两个组可以各自看到配置不同的 `shell` 提供方，互不影响。」
- **`!!js` 适用范围**：「`!!js` 仅在 `config` 与条目 `disabled` 字段内有效」；`disabled: !!js ...` 在每次挂载决策时
  基于 loader 上下文求值（本仓库的扩展），可做平台/环境门控；「其余元数据（`name`、`id`、`inject` 等）保持静态，
  其中的表达式是普通真值数据」。

### 9. 配置 schema（第 5、6 章）

- 「错误配置会导致加载失败，并给出准确的错误：插件绝不会在配置不完整时启动。」
- 同名导出 `Config` 既是 TS 接口又是运行时 schema（`export const Config: Schema<Config>`）。
- 可用实现：本仓库用 Schemastery；「Cordis 本身接受任意 Standard Schema 验证器，因此将普通对象导出为 `Config` 无法工作」。
- 默认值补齐：「未提供 `greeting`，因此 schema 默认值会将其补齐：`apply` 始终会收到完整且经过验证的配置。」
- 语义化拒绝：「如果某个插件的配置通过了 schema 验证，但其中指定的资源或提供方不可用，该插件也应当在能解析该引用时立即拒绝。」

### 10. HMR 行为（第 6 章）

- 机制：`@deepseek-ai/cordis-plugin-hmr` 监视文件，保存时执行「先卸载、再加载」；依赖 HMR 的前提是卸载释放 effect、加载遵循依赖。
- 必需配套：`@deepseek-ai/cordis-plugin-logger-console`（否则看不到 HMR 日志）与 `@deepseek-ai/cordis-plugin-timer`（否则 HMR 永远 PENDING）。
- 运行方式：「请在 tsx 下运行 Cordis」（`node --import tsx ../../vendor/cordis/bin.js`）；「HMR 通过 Loader 的原生辅助工具读取 Node 的 loader 内部结构」。
- 配置示例中 HMR 的配置为 `config: { root: ['.'] }`。
- 编辑 `cordis.yml` 本身也会触发更新，且按 `id` 做增量比较（见第 8 条）。
- 实测输出顺序：先打印既有的 `hello from my first plugin`，随后是 `hmr watching [ '.' ]`、`hmr reload plugin at hello.ts`、`hello from my EDITED plugin`。

### 11. 工具与 harness 接入（第 7 章）

- `ctx.tools.register(defineTool({ ... }))` 注册工具，注册 disposer 附着到插件，「因此卸载时会注销工具」。
- `defineTool` 契约：`parameters` 规约 → 向模型展示的 JSON Schema；推导 `args` 类型；在 `execute` 运行前校验模型提供的参数；
  返回由 `output.schema` 声明的规范值；`output.render` 作为 Native renderer 另行生成可持久化的结果内容。
- 直接驱动流水线需要 `callId`（`brandString<ToolCallId>('demo-1')`）、`name`、`arguments`、`signal`（`AbortController().signal`）。
- 组合必须同时列出 `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-tools`：后者注入 `systemPrompt` 服务，
  「缺少提供方时，工具插件会……保持 PENDING」。
- 观察者与提供者互不知晓：「两个插件都不知道另一个插件存在，它们由注册表服务和事件连接」。
- 通往完整 agent：base profile 层 + headless 层 + LLM 适配器 + agent loop + 持久化 + 应用入口，并用小型 `--patch` overlay 加入自有插件。

### 12. 教程范围边界（总览页）

- 本教程用 `vendor/cordis/bin.js` 启动器；**为 harness 本身编写插件**（由 `cordis.yml` 加载、在 Web UI 中驱动）
  是另一条路，入口是 `develop/basic/`。
- 教程不需要 API 密钥，全部示例可在无密钥环境运行；第 7 章明确「不会调用模型」。
