import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamSkillHost } from '../src/host.ts'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：服务端错误信封的 `request_id` 必须被 Host 捕获并随失败结果呈现；
 *   丢弃它会让运维无法按 request id 取证。
 * - 类型错误：信封不合法时既有 errorOf 已经拒绝（SERVICE_PROTOCOL_ERROR）。
 * - 边界：403 授权类失败必须归到 `authorization` 阶段且不可重试。
 * - 并发：无。
 * - 下游失败：本探针即为下游失败路径。
 * - 审计：request id 是审计/取证关联键，不是业务状态。
 */

const services: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of services.splice(0)) await dispose()
})

const ENVIRONMENT = {
  dshVersion: '0.1.1',
  availableTools: [],
  availableMcpServers: [],
  presentEnvironmentVariableNames: [],
} as const

function envelope(code: string, message: string, requestId: string, status: number): Response {
  return new Response(JSON.stringify({ code, message, request_id: requestId, data: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function hostWith(fetch: typeof globalThis.fetch): Promise<TeamSkillHost> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-install-failure-'))
  return new TeamSkillHost({
    apiBaseUrl: 'https://service.example.test/v1',
    accessToken: 'token-1',
    stateDirectory: join(root, 'state'),
    globalSkillRoot: join(root, 'global-skills'),
    fetch,
    refreshSkillCatalog: async () => true,
  })
}

const REQUEST = {
  skillId: 'skill-1',
  version: '1.0.0',
  projectId: 'project-alpha',
  scope: 'global',
  environment: ENVIRONMENT,
} as const

describe('§11.14 安装失败的 request id', () => {
  it('服务端 403 的 request_id 随失败结果返回，并归到 authorization 阶段', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      envelope('SKILL_NOT_PROJECT_ASSET', '该项目未绑定该 Skill。', 'req-403', 403),
    )
    const host = await hostWith(fetch)

    const result = await host.install({ ...REQUEST })

    expect(result).toMatchObject({
      status: 'failed',
      code: 'SKILL_NOT_PROJECT_ASSET',
      requestId: 'req-403',
      failedStage: 'authorization',
      retryable: { retryable: false },
    })
    // 授权失败不得产生任何本地写入。
    const stages = (result as { stages: readonly { stage: string; outcome: string }[] }).stages
    expect(stages.map(stage => stage.stage)).toEqual([
      'authorization',
      'precheck',
      'download',
      'verify',
      'write',
      'discovery',
      'rollback',
    ])
    expect(stages.filter(stage => stage.outcome === 'succeeded')).toHaveLength(0)
  })

  it('下游不可用归到 precheck 且可重试，同样带回 request_id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      envelope('UPSTREAM_UNAVAILABLE', '依赖服务暂不可用。', 'req-503', 503),
    )
    const host = await hostWith(fetch)

    const result = await host.install({ ...REQUEST })

    expect(result).toMatchObject({
      status: 'failed',
      requestId: 'req-503',
      failedStage: 'precheck',
      retryable: { retryable: true },
    })
  })

  it('信封缺 request_id 时按协议错误拒绝，不伪造一个 id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ code: 'NOT_FOUND', message: '资源不存在', data: null }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const host = await hostWith(fetch)

    const result = await host.install({ ...REQUEST })

    expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_PROTOCOL_ERROR' })
    expect((result as { requestId?: string }).requestId).toBeUndefined()
  })
})
