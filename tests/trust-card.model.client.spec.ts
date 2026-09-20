import { describe, expect, it } from 'vitest'
import {
  installStageRows,
  installedStateLabel,
  trustCardSections,
} from '../src/client/team-skills/trust-card.ts'
import type { TeamSkillTrustCard } from '../src/types.ts'

/**
 * 契约探针：《DSH-平台模块现状与后端API需求.md》§11.14（2026-09-16 冻结）。
 *
 * 异常矩阵：
 * - 缺失：空权限、无外部访问、无审计都必须以文字说明呈现，不得留下空行或空值；
 *   用户不能把「没有」误读成「没读到」。
 * - 类型错误：阶段词表外的取值原样透出，不得被丢弃或改写成成功。
 * - 边界：未执行（skipped）的阶段不得显示为完成；`publishedVersion` 未知时不得
 *   谎报「需要更新」。
 * - 并发：无（纯函数）。
 * - 下游失败：本层不产生请求；失败态由调用方以结果联合类型传入。
 * - 审计：审计行展示 actor_name 与 request_id，不做省略。
 */

function card(overrides: Partial<TeamSkillTrustCard> = {}): TeamSkillTrustCard {
  return {
    skillId: 'skill-1',
    version: '1.0.0',
    displayName: '信任卡探针',
    publisher: { name: '发布者', organizationId: 'org-alpha' },
    signature: {
      algorithm: 'sha256-ecdsa',
      keyId: 'fixture-release-key',
      fingerprint: 'f'.repeat(64),
      signedAt: '2026-09-16T00:00:00.000Z',
    },
    toolPermissions: ['read_file', 'web_fetch'],
    fileScope: { roots: ['.'], maxFiles: 64, maxBytes: 8388608 },
    externalAccess: { network: true, hosts: ['pkg.example.com'] },
    recentAudits: [
      {
        at: '2026-09-16T00:00:00.000Z',
        action: '发布版本',
        outcome: 'succeeded',
        actorName: '管理员',
        requestId: 'r-1',
      },
    ],
    ...overrides,
  }
}

function rowsOf(sections: ReturnType<typeof trustCardSections>, key: string): Readonly<Record<string, string>> {
  const section = sections.find(item => item.key === key)
  if (section === undefined) throw new Error(`missing section ${key}`)
  return Object.fromEntries(section.rows.map(row => [row.key, row.value]))
}

describe('§11.14 信任卡展示模型', () => {
  it('四个分区齐全，并把权限与外部访问翻译成中文标签', () => {
    const sections = trustCardSections(card())

    expect(sections.map(section => section.key)).toEqual(['publisher', 'signature', 'scope', 'audits'])
    const scope = rowsOf(sections, 'scope')
    expect(scope.permissions).toBe('读取文件、访问网络')
    expect(scope.roots).toContain('最多 64 个文件')
    expect(scope.external).toBe('pkg.example.com')
    // 签名四字段必须原样出现，不做省略。
    const signature = rowsOf(sections, 'signature')
    expect(Object.keys(signature).sort()).toEqual(['algorithm', 'fingerprint', 'key', 'signed_at'])
    for (const value of Object.values(signature)) expect(value.length).toBeGreaterThan(0)
  })

  it('不申请权限、不访问外网、无审计时给出明确文字而非空值', () => {
    const sections = trustCardSections(card({
      toolPermissions: [],
      externalAccess: { network: false, hosts: [] },
      recentAudits: [],
    }))

    const scope = rowsOf(sections, 'scope')
    expect(scope.permissions).toBe('不申请任何工具权限')
    expect(scope.external).toBe('不访问外部网络')
    const audits = rowsOf(sections, 'audits')
    expect(audits.none).toContain('暂无')
  })

  it('审计行带结果、操作者与 request_id，不省略', () => {
    const sections = trustCardSections(card({
      recentAudits: [
        { at: '2026-09-16T00:00:00.000Z', action: '发布版本', outcome: 'succeeded', actorName: '管理员', requestId: 'r-1' },
        { at: '2026-09-16T01:00:00.000Z', action: '下线版本', outcome: 'failed', actorName: '审计员', requestId: 'r-2' },
      ],
    }))

    const auditRows = sections.find(section => section.key === 'audits')?.rows ?? []
    expect(auditRows).toHaveLength(2)
    expect(auditRows[0]?.value).toContain('成功')
    expect(auditRows[0]?.value).toContain('管理员')
    expect(auditRows[0]?.value).toContain('r-1')
    expect(auditRows[1]?.value).toContain('失败')
  })

  it('词表外的工具权限原样透出，不丢弃也不改写成别的权限', () => {
    const sections = trustCardSections(card({ toolPermissions: ['bash', 'future_permission'] as never }))

    const scope = rowsOf(sections, 'scope')
    expect(scope.permissions).toBe('执行命令、future_permission')
  })
})

describe('§11.14 安装阶段展示模型', () => {
  const stages = [
    { stage: 'authorization', outcome: 'succeeded', detail: '已授权' },
    { stage: 'precheck', outcome: 'succeeded', detail: '预检通过' },
    { stage: 'download', outcome: 'succeeded', detail: '已下载' },
    { stage: 'verify', outcome: 'succeeded', detail: '校验通过' },
    { stage: 'write', outcome: 'failed', detail: '写入失败' },
    { stage: 'discovery', outcome: 'skipped', detail: '前序阶段失败，本阶段未执行。' },
    { stage: 'rollback', outcome: 'succeeded', detail: '已回滚' },
  ] as const

  it('保持服务端顺序并翻译阶段与结果标签', () => {
    const rows = installStageRows([...stages])

    expect(rows.map(row => row.stage)).toEqual(stages.map(stage => stage.stage))
    expect(rows.map(row => row.label)).toEqual(['授权', '预检', '下载', '校验', '写入', '运行时发现', '回滚'])
    expect(rows[4]?.outcome).toBe('失败')
    // 未执行的阶段不得显示为已完成。
    expect(rows[5]?.outcome).toBe('未执行')
    expect(rows[6]?.outcome).toBe('已完成')
    expect(rows.map(row => row.rawOutcome)).toEqual(stages.map(stage => stage.outcome))
    for (const row of rows) expect(row.detail.length).toBeGreaterThan(0)
  })

  it('词表外的阶段名原样透出，不丢弃也不改写结果', () => {
    const rows = installStageRows([
      { stage: 'future_stage' as never, outcome: 'succeeded', detail: '未来阶段' },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.stage).toBe('future_stage')
    expect(rows[0]?.detail).toBe('未来阶段')
  })

  it('词表外的阶段结果原样透出，rawOutcome 保留线上取值', () => {
    const rows = installStageRows([
      { stage: 'verify', outcome: 'aborted' as never, detail: '运行被中止' },
    ])

    expect(rows[0]?.label).toBe('校验')
    // 结果既不得被吞成「未执行」，也不得被改写成「已完成」。
    expect(rows[0]?.outcome).toBe('aborted')
    expect(rows[0]?.rawOutcome).toBe('aborted')
  })
})

describe('§11.14 已安装状态', () => {
  it('隔离副本报已撤销，即使目录仍列出同一版本', () => {
    expect(installedStateLabel('withdrawn', '1.0.0', '1.0.0')).toBe('已撤销')
  })

  it('版本落后于目录时报需要更新', () => {
    expect(installedStateLabel('normal', '1.0.0', '1.1.0')).toBe('需要更新')
  })

  it('版本一致时报已安装；目录版本未知时不谎报需要更新', () => {
    expect(installedStateLabel('normal', '1.0.0', '1.0.0')).toBe('已安装')
    expect(installedStateLabel('normal', '1.0.0', undefined)).toBe('已安装')
  })

  it('已卸载是独立状态，不与已撤销合并', () => {
    expect(installedStateLabel('uninstalled', '1.0.0', '1.0.0')).toBe('已卸载')
  })
})
