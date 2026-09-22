/* 部署可调参数的契约。
 *
 * 官方手册的 Harness 约定：「凡是不同部署可能需要采用不同值的参数，都必须定义为配置
 * 字段」，检验标准是「能否只在 `cordis.yml` 里改这个值而不需要修改代码」。
 *
 * 这条约定只有两半都成立才算数：
 *
 * 1. **schema 里带默认值** —— loader 校验后会把默认填上，所以部署只在需要时才写；
 * 2. **运行时回退与 schema 默认一致** —— 测试与内嵌构造直接 `new Gateway(ctx, config)`
 *    会绕过 schema，若两边默认值漂移，同一份配置在两条构造路径上行为不同。
 *
 * 本文件钉住这两条。任何把可调值重新改回模块常量、或让两处默认值分家的改动都会红。
 */
import { describe, expect, it } from 'vitest'
import {
  SKILL_DISCOVERY_CONFIRM_INTERVAL_MS,
  SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS,
  TeamSkillGateway,
} from '../src/gateway.ts'
import { WorkspaceGateway } from '../src/workspace-gateway.ts'
import { HOST_BRIDGE_MAX_BODY_BYTES } from '../src/host-bridge.ts'
import { DEFAULT_EVENT_BUFFER_LIMIT, DEFAULT_PAGE_WALK_LIMIT } from '../src/workspace-host.ts'

/** The two required Team Skill row keys; every other key must be optional. */
const REQUIRED_TEAM_SKILL_CONFIG = { stateDirectory: 'C:/dsh/ai-coding-platform', globalSkillRoot: 'C:/dsh/skills' }

describe('Team Skill 行的部署可调参数', () => {
  it('省略 discovery 时 schema 补齐两个默认值', () => {
    const resolved = TeamSkillGateway.Config(REQUIRED_TEAM_SKILL_CONFIG)
    expect(resolved.discovery).toEqual({
      confirmTimeoutMs: SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS,
      confirmIntervalMs: SKILL_DISCOVERY_CONFIRM_INTERVAL_MS,
    })
  })

  it('只写一项时另一项仍取默认值', () => {
    const resolved = TeamSkillGateway.Config({ ...REQUIRED_TEAM_SKILL_CONFIG, discovery: { confirmTimeoutMs: 9_000 } })
    expect(resolved.discovery).toEqual({ confirmTimeoutMs: 9_000, confirmIntervalMs: SKILL_DISCOVERY_CONFIRM_INTERVAL_MS })
  })

  it('schema 默认值与运行时回退是同一个数', () => {
    // 直接构造绕过 schema（测试与内嵌用法都这样），回退值必须与 schema 一致。
    const resolved = TeamSkillGateway.Config(REQUIRED_TEAM_SKILL_CONFIG)
    expect(resolved.hostBridgeMaxBodyBytes).toBe(HOST_BRIDGE_MAX_BODY_BYTES)
    expect(resolved.discovery?.confirmTimeoutMs).toBe(SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS)
    expect(resolved.discovery?.confirmIntervalMs).toBe(SKILL_DISCOVERY_CONFIRM_INTERVAL_MS)
  })

  it('拒绝非法类型，而不是静默接受', () => {
    expect(() => TeamSkillGateway.Config({ ...REQUIRED_TEAM_SKILL_CONFIG, discovery: { confirmTimeoutMs: 'soon' } })).toThrow()
    expect(() => TeamSkillGateway.Config({ ...REQUIRED_TEAM_SKILL_CONFIG, hostBridgeMaxBodyBytes: 'big' })).toThrow()
  })

  it('两个必填键仍然必填', () => {
    expect(() => TeamSkillGateway.Config({ globalSkillRoot: 'C:/dsh/skills' })).toThrow()
    expect(() => TeamSkillGateway.Config({ stateDirectory: 'C:/dsh/ai-coding-platform' })).toThrow()
  })
})

describe('云工作空间行的部署可调参数', () => {
  it('省略时 schema 补齐缓冲区与游走上限', () => {
    const resolved = WorkspaceGateway.Config({})
    expect(resolved.eventBufferLimit).toBe(DEFAULT_EVENT_BUFFER_LIMIT)
    expect(resolved.pageWalkLimit).toBe(DEFAULT_PAGE_WALK_LIMIT)
  })

  it('显式值与其余默认值共存', () => {
    const resolved = WorkspaceGateway.Config({ pageWalkLimit: 25 })
    expect(resolved.pageWalkLimit).toBe(25)
    expect(resolved.eventBufferLimit).toBe(DEFAULT_EVENT_BUFFER_LIMIT)
  })

  it('拒绝非法类型', () => {
    expect(() => WorkspaceGateway.Config({ pageWalkLimit: 'many' })).toThrow()
  })
})

describe('默认值本身是当前行为', () => {
  it('发现确认窗口与缓冲区上限保持改造前的数值', () => {
    // 改造只把数值搬到配置里，不得顺手改行为。
    expect(SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS).toBe(5_000)
    expect(SKILL_DISCOVERY_CONFIRM_INTERVAL_MS).toBe(100)
    expect(DEFAULT_EVENT_BUFFER_LIMIT).toBe(256)
    expect(DEFAULT_PAGE_WALK_LIMIT).toBe(1000)
    expect(HOST_BRIDGE_MAX_BODY_BYTES).toBe(1024 * 1024)
  })
})
