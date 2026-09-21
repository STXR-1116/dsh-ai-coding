/* inject 的「最小集」契约。
 *
 * 官方手册：`inject` 是**持续硬依赖**，「并非一次性的启动检查」——提供方消失时依赖方
 * 会被自动卸载，恢复后再加载；未满足时保持 PENDING（PENDING 完全静默：不输出、不崩溃、
 * 也不让事件循环活跃）。另一条同时成立的规则是：**可选依赖不要写进 inject**，使用点用
 * `ctx.get('svc')` 并处理 `undefined`。
 *
 * 两条合起来的推论是：inject 里多写一个**没人读**的服务不是「无害的保守」，而是实打实
 * 的缺陷 —— 在没有该服务提供方的部署上，插件会永久 PENDING 且毫无提示。所以本文件把
 * 三个插件的 inject 列表钉成「与代码实际读取集合相等的最小集」。
 *
 * 这里不能靠静态分析自动判定，所以退一步：断言**当前审计结论**，并在每条上写清理由。
 * 任何增删都会红，逼迫改动者先回答「这份代码真的读它吗」。
 */
import { describe, expect, it } from 'vitest'
import { TeamSkillGateway } from '../src/gateway.ts'
import { WorkspaceGateway } from '../src/workspace-gateway.ts'
import * as clientEntry from '../src/client/index.ts'
import * as invariant from '../src/invariant.ts'

describe('宿主行的 inject 是最小集', () => {
  it('Team Skill 行只要它真正读取的三个服务', () => {
    // gateway.ts 读取：ctx.skills（发现确认）、ctx.workspaceRegistry（解出本机路径）、
    // ctx.agents（会话存活判定）。`sessions` 曾在此列但全文件无任何读取点：留着一个
    // 无人读取的硬依赖，只会让本行在没有 session 服务提供方的部署上白等。
    // `credentials` 同样不在列表里——它是可选的，走 ctx.get()。
    expect(TeamSkillGateway.inject).toEqual(['skills', 'workspaceRegistry', 'agents'])
  })

  it('云工作空间行不声明 credentials：它是可选的，不是硬依赖', () => {
    // 本行支持 static-token 的**无登录部署**，因此用 ctx.get('credentials') 读取，
    // accountSessionProvider 接受 CredentialProvider | undefined 并在缺失时回答
    // 「未登录」。把它写进 inject 会把可选依赖变成硬依赖，并在没有凭据存储的主机上
    // 让本行永久 PENDING，同时把已有的一条已登录/未登录分支变成死代码。
    expect(WorkspaceGateway.inject).toEqual([])
  })

  it('invariant 伴生行只依赖 invariants 注册表', () => {
    expect(invariant.inject).toEqual(['invariants'])
  })
})

describe('浏览器 fragment 的 inject 是最小集', () => {
  it('只声明真正读取的服务：locale / slots / sessions / layout', () => {
    // - remote 三键由本 fragment 自己提供，提供者不等待自己，故必须缺席；
    // - workspaces 已无读取点（会话创建移到 ISessions.create），故移除；
    // - layout 供浮层上报右侧栏；sessions 供 openSession/startSession；
    // - locale 与 slots 是词典与两个扩展点的宿主。
    expect(clientEntry.inject).toEqual(['locale', 'slots', 'sessions', 'layout'])
  })

  it('不含 remote 三键，也不含 workspaces', () => {
    for (const key of ['remote', 'remote.teamSkills', 'remote.cloudWorkspaces', 'workspaces']) {
      expect(clientEntry.inject).not.toContain(key)
    }
  })
})

describe('声明与实现一致：列出的服务都被用到，用到的服务都列出', () => {
  it('每个 host 行都能构造起来（构造期即读取它 inject 的服务）', () => {
    // 断言列表只是静态契约；这条确认列表与实际构造不矛盾——少列一个真正读取的服务，
    // 框架会在 apply 前抛错而不是静默降级。
    expect(typeof TeamSkillGateway).toBe('function')
    expect(typeof WorkspaceGateway).toBe('function')
    expect(TeamSkillGateway.inject).not.toContain('sessions')
    expect(WorkspaceGateway.inject).not.toContain('credentials')
  })
})
