/**
 * Agent 配置编辑器（蓝图 §2-6，§11.12）：详情面板内的编辑流组件。
 * 已发布配置不可直接编辑——「编辑」经 createProfileVersion 自动创建草稿；
 * 资产选择器统一呈现名称/版本/用途/授权状态/readiness/更新时间/来源；
 * 发布前「配置试运行」只执行准备与上下文装配，无外部副作用。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { AssetCandidate, ProfileDryRun, ProfileEditContext, WorkspaceQueryResult } from '@deepseek-ai/dsh-ai-coding-platform/types'
import { buildAssetSelectorRows, dryRunChecksView, planProfileEdit } from '../cloud-workspaces/agent-config-editor.ts'
import css from './AgentConfigEditor.module.css'

export interface AgentConfigEditorProps {
  readonly remote: ClientRemote
  /** 编辑目标的配置 id。 */
  readonly profileId: string
  /** 编辑流结束（发布成功或放弃）后的回调。 */
  readonly onFinished?: () => void
}

type EditorState =
  | { readonly status: 'loading' }
  | { readonly status: 'blocked'; readonly reason: string }
  | { readonly status: 'ready'; readonly ctx: ProfileEditContext; readonly draftVersionId: string }

/** 一次配置试运行的结果状态。 */
type DryRunState =
  | { readonly status: 'idle' }
  | { readonly status: 'ready'; readonly result: ProfileDryRun }
  | { readonly status: 'failed'; readonly code: string; readonly message: string }

/** 编辑器内部状态机：读上下文 → 规划 → （必要时建草稿）→ 可编辑。 */
export function AgentConfigEditor({ remote, profileId, onFinished }: AgentConfigEditorProps): ReactElement {
  const [state, setState] = useState<EditorState>({ status: 'loading' })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [draftVersionId, setDraftVersionId] = useState<string | undefined>()
  const [dryRun, setDryRun] = useState<DryRunState>({ status: 'idle' })
  const [candidates, setCandidates] = useState<ReturnType<typeof buildAssetSelectorRows>>([])
  const [message, setMessage] = useState<string | undefined>()

  type EditorEnvelope =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  const unwrap = useCallback((envelope: EditorEnvelope): unknown => {
    if (!envelope.ok) throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code })
    return envelope.value
  }, [])

  const loadContext = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' })
    try {
      const result = unwrap(await remote.cloudWorkspaces.profileEditContext(profileId)) as WorkspaceQueryResult<ProfileEditContext>
      if (result.status !== 'ready') {
        setState({ status: 'blocked', reason: result.status === 'failed' ? result.message : '配置不可编辑' })
        return
      }
      const ctx = result.value
      const latest = ctx.versions[ctx.versions.length - 1]
      const plan = planProfileEdit(latest?.status ?? 'archived')
      if (plan.mode === 'blocked') {
        setState({ status: 'blocked', reason: plan.reason ?? '不可编辑' })
        return
      }
      if (plan.mode === 'new-draft') {
        // 已发布配置不可直接编辑：编辑自动创建草稿版本（§11.12 组合）。
        const envelope = await remote.cloudWorkspaces.createProfileVersion({ profileId, expectedRevision: ctx.revision })
        const created = unwrap(envelope) as WorkspaceQueryResult<ProfileEditContext>
        if (created.status !== 'ready') {
          setState({ status: 'blocked', reason: created.status === 'failed' ? created.message : '草稿创建失败' })
          return
        }
        const drafts = created.value.versions.filter(version => version.status === 'draft')
        const draftId = drafts[drafts.length - 1]?.agentProfileVersionId
        if (draftId === undefined) {
          setState({ status: 'blocked', reason: '草稿创建失败：服务端未返回草稿版本' })
          return
        }
        setDraftVersionId(draftId)
        setState({ status: 'ready', ctx: created.value, draftVersionId: draftId })
        return
      }
      const draftId = latest?.agentProfileVersionId
      if (draftId === undefined) {
        setState({ status: 'blocked', reason: '配置缺少草稿版本' })
        return
      }
      setDraftVersionId(draftId)
      setState({ status: 'ready', ctx, draftVersionId: draftId })
    } catch (error) {
      setState({ status: 'blocked', reason: error instanceof Error ? error.message : '配置读取失败' })
    }
  }, [profileId, remote, unwrap])

  useEffect(() => {
    void loadContext()
  }, [loadContext])

  useEffect(() => {
    if (state.status !== 'ready') return
    void (async (): Promise<void> => {
      try {
        const envelope = await remote.cloudWorkspaces.assetCandidates('')
        const result = unwrap(envelope) as WorkspaceQueryResult<readonly AssetCandidate[]>
        if (result.status === 'ready') setCandidates(buildAssetSelectorRows(result.value))
      } catch {
        // 资产候选读取失败保留空表：编辑器主体仍可用，失败不冒充空数据语义。
      }
    })()
  }, [remote, state.status, unwrap])

  const saveDraft = useCallback(async (): Promise<void> => {
    if (state.status !== 'ready' || draftVersionId === undefined) return
    try {
      unwrap(await remote.cloudWorkspaces.updateProfileDraft({
        profileId, expectedRevision: state.ctx.revision, patch: { name, description },
      }))
      setMessage('草稿已保存')
      await loadContext()
    } catch (error) {
      setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败')
    }
  }, [draftVersionId, loadContext, name, description, profileId, remote, state])

  const runDryRun = useCallback(async (): Promise<void> => {
    if (draftVersionId === undefined) return
    setDryRun({ status: 'ready', result: {
      dryRunId: '', agentProfileVersionId: draftVersionId, outcome: 'ready', checks: [], createdAt: '',
    } })
    try {
      const envelope = await remote.cloudWorkspaces.dryRunProfile({ profileId, versionId: draftVersionId })
      const result = unwrap(envelope) as WorkspaceQueryResult<ProfileDryRun>
      if (result.status !== 'ready') {
        setDryRun({ status: 'failed', code: result.status === 'failed' ? result.code : 'UNKNOWN', message: result.status === 'failed' ? result.message : '试运行失败' })
        return
      }
      setDryRun({ status: 'ready', result: result.value })
    } catch (error) {
      setDryRun({ status: 'failed', code: 'LOCAL_OPERATION_FAILED', message: error instanceof Error ? error.message : '试运行失败' })
    }
  }, [draftVersionId, profileId, remote])

  const publish = useCallback(async (): Promise<void> => {
    if (state.status !== 'ready' || draftVersionId === undefined) return
    try {
      unwrap(await remote.cloudWorkspaces.publishProfileVersion({
        profileId, versionId: draftVersionId, expectedRevision: state.ctx.revision,
      }))
      setMessage('发布成功')
      onFinished?.()
    } catch (error) {
      setMessage(error instanceof Error ? `发布失败：${error.message}` : '发布失败')
    }
  }, [draftVersionId, onFinished, profileId, remote, state])

  const dryView = dryRun.status === 'ready' && dryRun.result.checks.length > 0 ? dryRunChecksView(dryRun.result) : undefined

  return (
    <section className={css.editor} aria-label="配置编辑器">
      <p className={css.editorTitle}>编辑（自动创建草稿版本）</p>
      {state.status === 'loading' && <p className={css.editorHint}>正在读取配置上下文…</p>}
      {state.status === 'blocked' && <p className={css.editorHint} role="alert">{`不可编辑：${state.reason}`}</p>}
      {state.status === 'ready' && (
        <>
          <label className={css.editorField}>
            名称
            <input value={name} onChange={(event) => { setName(event.target.value) }} placeholder={state.ctx.name} />
          </label>
          <label className={css.editorField}>
            描述
            <input value={description} onChange={(event) => { setDescription(event.target.value) }} />
          </label>
          <p className={css.editorHint}>{`草稿版本：${draftVersionId ?? ''}`}</p>
          <table className={css.assetTable}>
            <caption>资产选择器</caption>
            <thead>
              <tr><th>名称</th><th>版本</th><th>用途</th><th>授权</th><th>readiness</th><th>更新时间</th><th>来源</th><th>可选</th></tr>
            </thead>
            <tbody>
              {candidates.map(row => (
                <tr key={row.assetId} data-selectable={row.selectable ? 'true' : 'false'}>
                  <td>{row.name}</td>
                  <td>{row.version}</td>
                  <td>{row.purpose}</td>
                  <td>{row.authorized ? '已授权' : '未授权'}</td>
                  <td>{row.readiness}</td>
                  <td>{row.updatedAt}</td>
                  <td>{row.source}</td>
                  <td>{row.selectable ? '可选' : `不可选：${row.unavailableReason ?? ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={css.editorActions}>
            <button type="button" onClick={() => { void saveDraft() }}>保存草稿</button>
            <button type="button" onClick={() => { void runDryRun() }}>配置试运行</button>
            <button type="button" onClick={() => { void publish() }}>发布草稿</button>
          </div>
          {message !== undefined && <p className={css.editorHint} role="status">{message}</p>}
          {dryView !== undefined && (
            <div className={css.dryRunPanel} role="status" aria-label="配置试运行结果">
              <p className={css.editorTitle}>{`试运行：${dryView.outcomeLabel}`}</p>
              <ul>
                {dryView.rows.map(row => (
                  <li key={row.check}>{`${row.checkLabel}（${row.resultLabel}）：${row.detail}`}</li>
                ))}
              </ul>
            </div>
          )}
          {/* 试运行失败此前没有任何出口：点「配置试运行」失败后界面毫无变化，
              与保存/发布的显式回报不一致。失败必须与成功一样看得见。 */}
          {dryRun.status === 'failed' && (
            <p className={css.editorHint} role="alert">{`试运行失败：${dryRun.message}（${dryRun.code}）`}</p>
          )}
        </>
      )}
    </section>
  )
}
