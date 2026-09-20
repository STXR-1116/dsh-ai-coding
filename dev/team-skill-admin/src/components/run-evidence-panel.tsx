/**
 * 运行证据时间轴面板（蓝图 §6.7，4-7）：独立组件文件。
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { TeamSkillApi } from '../lib/team-skill-api'
import type { CloudRun } from '../lib/team-skill-types'

export interface RunEvidencePanelProps {
  readonly api: TeamSkillApi
  readonly run: CloudRun
  readonly onClose: () => void
}

interface PulseEntry {
  readonly kind: string
  readonly at: string
  readonly summary: string
  readonly detail: string
}

export function RunEvidencePanel({ api, run, onClose }: RunEvidencePanelProps): ReactElement {
  const [entries, setEntries] = useState<readonly PulseEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    void api.runPulse(run.run_id).then((result) => {
      if (disposed) return
      setLoading(false)
      if (!result.ok) { setFailed(true); return }
      const items = result.value['items']
      if (!Array.isArray(items)) { setEntries([]); return }
      setEntries(items.map((raw: unknown) => {
        const item = raw as Record<string, unknown>
        const str = (key: string): string => { const v = item[key]; return typeof v === 'string' ? v : '' }
        return {
          kind: str('kind'),
          at: str('at'),
          summary: str('summary'),
          detail: str('detail') || str('reason') || str('result'),
        }
      }))
    })
    return () => { disposed = true }
  }, [api, run.run_id])

  return (
    <section aria-label="运行证据时间轴">
      <h4>{`运行证据：${run.run_id}`}</h4>
      <button type="button" onClick={onClose} aria-label="关闭运行证据">关闭</button>
      {loading && <p>正在读取脉搏…</p>}
      {failed && <p role="alert">脉搏读取失败</p>}
      {!loading && !failed && (
        <ol>
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              <strong>{entry.kind}</strong>
              {' · '}
              {entry.at}
              {' · '}
              {entry.summary}
              {entry.detail !== '' && <small>{` · ${entry.detail}`}</small>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
