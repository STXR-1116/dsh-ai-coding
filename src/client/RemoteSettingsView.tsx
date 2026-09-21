/** First-run deployment settings form for the browser remote client layer. */

import { useState } from 'react'
import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolvePlatformClientConfig } from './remote/config.ts'
import { writeBrowserSettings } from './remote/settings.ts'
import type { BrowserRemoteSettings } from './remote/settings.ts'
import css from './PlatformSurface.module.css'

/**
 * The unconfigured workbench's only screen: the deployment values the browser
 * remote services need, validated by the same resolver the services build on.
 * Saving persists them and the workbench proceeds to its account flow.
 *
 * The 0.1.5-rc.2 client runner delivers no mount-row configuration to browser
 * fragments, so this face — not the patch — is the browser deployment channel;
 * an unconfigured workbench stays here, naming exactly what is missing.
 */
export function RemoteSettingsView() {
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [workspaceApiBaseUrl, setWorkspaceApiBaseUrl] = useState('')
  const [workspaceAccessToken, setWorkspaceAccessToken] = useState('')
  const [authMode, setAuthMode] = useState<'account' | 'static-token'>('account')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const trimmed = (value: string): string | undefined => {
    const next = value.trim()
    return next.length === 0 ? undefined : next
  }

  return (
    <div className={css.loginPage} data-remote-settings="">
      <div className={css.loginAccent}>
        <IconSparkle16 size={20} />
      </div>
      <p className={css.kicker}>DSH / AI CODING PLATFORM</p>
      <h1>配置编程协作台的服务地址</h1>
      <p>浏览器端直接访问 AI Coding 服务。填写一次，保存在本机浏览器中。</p>
      <form
        className={css.loginForm}
        onSubmit={(event) => {
          event.preventDefault()
          const base = trimmed(apiBaseUrl)
          if (base === undefined) {
            setError('请填写服务地址（apiBaseUrl，含 /v1 前缀）。')
            return
          }
          const settings: BrowserRemoteSettings = {
            apiBaseUrl: base,
            ...(trimmed(workspaceApiBaseUrl) === undefined ? {} : { workspaceApiBaseUrl: trimmed(workspaceApiBaseUrl) as string }),
            ...(authMode === 'static-token' ? { authMode } : {}),
            ...(trimmed(accessToken) === undefined ? {} : { accessToken: trimmed(accessToken) as string }),
            ...(trimmed(workspaceAccessToken) === undefined ? {} : { workspaceAccessToken: trimmed(workspaceAccessToken) as string }),
          }
          // The same resolver the services build on decides here: a deployment
          // mistake surfaces as form feedback, never as a half-configured face.
          try {
            resolvePlatformClientConfig(settings)
          } catch (resolveError) {
            setError(resolveError instanceof Error ? resolveError.message : String(resolveError))
            return
          }
          setBusy(true)
          writeBrowserSettings(settings)
        }}
      >
        <label>
          平台服务地址（必填，含 /v1）
          <input
            type="url"
            name="dsh-ai-coding-api-base-url"
            placeholder="http://127.0.0.1:4100/v1"
            value={apiBaseUrl}
            onChange={(event) => {
              setApiBaseUrl(event.target.value)
            }}
            required
          />
        </label>
        <label>
          平台访问令牌（可选）
          <input
            type="password"
            name="dsh-ai-coding-access-token"
            autoComplete="off"
            value={accessToken}
            onChange={(event) => {
              setAccessToken(event.target.value)
            }}
          />
        </label>
        <label>
          云工作空间服务地址（可选，默认跟随平台地址）
          <input
            type="url"
            name="dsh-ai-coding-workspace-api-base-url"
            placeholder="跟随平台服务地址"
            value={workspaceApiBaseUrl}
            onChange={(event) => {
              setWorkspaceApiBaseUrl(event.target.value)
            }}
          />
        </label>
        <label>
          工作空间身份模式
          <select
            name="dsh-ai-coding-workspace-auth-mode"
            value={authMode}
            onChange={(event) => {
              setAuthMode(event.target.value === 'static-token' ? 'static-token' : 'account')
            }}
          >
            <option value="account">account — 使用面板登录的账号</option>
            <option value="static-token">static-token — 无登录部署的固定令牌</option>
          </select>
        </label>
        <label>
          工作空间固定令牌（仅 static-token 模式需要）
          <input
            type="password"
            name="dsh-ai-coding-workspace-access-token"
            autoComplete="off"
            value={workspaceAccessToken}
            onChange={(event) => {
              setWorkspaceAccessToken(event.target.value)
            }}
          />
        </label>
        {error !== undefined && (
          <span className={css.formError} role="alert">
            {error}
          </span>
        )}
        <button
          type="submit"
          className={css.primaryButton}
          disabled={busy || apiBaseUrl.trim().length === 0}
        >
          <IconSparkle16 size={16} />
          保存并继续
        </button>
      </form>
      <span className={css.formHint}>
        令牌保存在本机浏览器；account 模式使用面板登录的账号作为工作空间身份。
      </span>
    </div>
  )
}
