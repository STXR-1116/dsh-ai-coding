/**
 * 策略预演页面（蓝图 §6.9，4-9）：选择用户、项目、Agent、资产和动作，
 * 查看最终权限与审批要求。不改变状态、不写审计业务记录，只记录一次策略
 * 查询。可导出给评审。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { TeamSkillApi } from '../lib/team-skill-api'
import type { AdminProject, AdminUser } from '../lib/team-skill-types'

export interface StrategyPreviewPageProps {
  readonly api: TeamSkillApi
}

interface PreviewResult {
  readonly decision: string
  readonly code: string
  readonly reason: string
  readonly policyVersion: string
  readonly requestId: string
  readonly operator: string
}

/** 策略预演页面：只读，复用 §11.9 permission-check。 */
export function StrategyPreviewPage({ api }: StrategyPreviewPageProps): ReactElement {
  const [projects, setProjects] = useState<readonly AdminProject[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [selectedAction, setSelectedAction] = useState('workspace.read')
  const [result, setResult] = useState<PreviewResult | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void api.listProjects().then((result) => {
      if (result.ok) {
        setProjects(result.value)
        if (result.value.length > 0) setSelectedProject(result.value[0].project_id)
      }
    })
  }, [api])

  const run = useCallback(async (): Promise<void> => {
    if (selectedProject === '' || selectedAction === '') return
    setLoading(true)
    setError(undefined)
    const result = await api.permissionCheck({ action: selectedAction, project_id: selectedProject })
    setLoading(false)
    if (!result.ok) {
      setError(result.error.kind === 'not-ready' ? `服务尚未配置：缺少 ${result.error.missing.join('、')}` : result.error.message)
      return
    }
    const value = result.value
    const str = (key: string): string => {
      const v = value[key]
      return typeof v === 'string' ? v : ''
    }
    setResult({
      decision: str('decision'),
      code: str('code'),
      reason: str('reason'),
      policyVersion: str('policy_version'),
      requestId: str('request_id'),
      operator: str('operator'),
    })
  }, [api, selectedAction, selectedProject])

  return (
    <section className="page-body" aria-label="策略预演">
      <div className="page-intro">
        <div>
          <span className="eyebrow">策略预演</span>
          <h2>权限与审批要求预览</h2>
          <p>选择项目与动作，查看最终权限判定。只读预演，不改变状态。</p>
        </div>
      </div>
      <div className="account-toolbar">
        <label>
          项目
          <select value={selectedProject} onChange={(event) => { setSelectedProject(event.target.value) }}>
            <option value="">选择项目</option>
            {projects.map(project => (
              <option key={project.project_id} value={project.project_id}>{project.name}</option>
            ))}
          </select>
        </label>
        <label>
          动作
          <select value={selectedAction} onChange={(event) => { setSelectedAction(event.target.value) }}>
            <option value="workspace.read">workspace.read</option>
            <option value="workspace.write">workspace.write</option>
            <option value="admin.skill.publish">admin.skill.publish</option>
            <option value="admin.audit.read">admin.audit.read</option>
          </select>
        </label>
        <button type="button" className="button primary" disabled={loading || selectedProject === ''} onClick={() => { void run() }}>
          {loading ? '评估中…' : '运行预演'}
        </button>
      </div>
      {error !== undefined && <p className="state-line" role="alert">{error}</p>}
      {result !== undefined && (
        <dl className="workbench-facts" aria-label="策略预演结果">
          <div><dt>判定</dt><dd>{result.decision === 'allowed' ? '允许' : '拒绝'}</dd></div>
          <div><dt>错误码</dt><dd>{result.code}</dd></div>
          <div><dt>原因</dt><dd>{result.reason}</dd></div>
          <div><dt>策略版本</dt><dd>{result.policyVersion}</dd></div>
          <div><dt>request ID</dt><dd>{result.requestId}</dd></div>
          <div><dt>操作者</dt><dd>{result.operator}</dd></div>
        </dl>
      )}
      <p className="state-line">本页面为只读策略查询，不产生业务状态变更或写审计（仅记录一次策略查询日志）。</p>
    </section>
  )
}

// Re-export AdminUser for consumers that need the type.
export type { AdminUser }
