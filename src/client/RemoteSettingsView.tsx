/** First-run deployment settings form for the browser remote client layer. */

import { useState } from 'react'
import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolvePlatformClientConfig } from './remote/config.ts'
import { clearBrowserSettings, readBrowserSettings, readDeploymentSettings, resolveBrowserSettings, writeBrowserSettings } from './remote/settings.ts'
import type { BrowserRemoteSettings } from './remote/settings.ts'
import css from './PlatformSurface.module.css'

/** Props for {@link RemoteSettingsView}. */
export interface RemoteSettingsViewProps {
  /**
   * Present when the form is opened over a running workbench rather than
   * standing in for an unconfigured one: shows a way back without saving.
   */
  readonly onCancel?: (() => void) | undefined
}

/**
 * The deployment values the browser remote services need, validated by the same
 * resolver the services build on.
 *
 * It is two things depending on how it is reached. With nothing configured it is
 * the workbench's only screen — the config channel for a bare mount, naming
 * exactly what is missing. It is also the **override editor**, reachable from the
 * workbench's failure state, because a configured-but-unreachable endpoint has to
 * be correctable from the browser that is hitting it: the deployment declaration
 * supplies the default, and this form is how an operator departs from it or drops
 * the departure again.
 */
export function RemoteSettingsView({ onCancel }: RemoteSettingsViewProps = {}) {
  // Prefill from whatever is in effect, so opening this to fix a broken address
  // shows the broken address rather than an empty form.
  const effective = resolveBrowserSettings()
  const stored = readBrowserSettings()
  const declared = readDeploymentSettings()
  const [apiBaseUrl, setApiBaseUrl] = useState(stored?.apiBaseUrl ?? declared?.apiBaseUrl ?? '')
  const [accessToken, setAccessToken] = useState(stored?.accessToken ?? declared?.accessToken ?? '')
  const [workspaceApiBaseUrl, setWorkspaceApiBaseUrl] = useState(stored?.workspaceApiBaseUrl ?? declared?.workspaceApiBaseUrl ?? '')
  const [workspaceAccessToken, setWorkspaceAccessToken] = useState(stored?.workspaceAccessToken ?? declared?.workspaceAccessToken ?? '')
  const [authMode, setAuthMode] = useState<'account' | 'static-token'>(stored?.authMode ?? declared?.authMode ?? 'account')
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
      <p>
        {declared === undefined
          ? '本部署未声明服务地址，请在浏览器端填写。填写一次，保存在本机浏览器中。'
          : '本部署已声明服务地址，下面是当前生效的值。修改会覆盖本机对部署值的采用，保存在本机浏览器中。'}
      </p>
      {effective !== undefined && (
        <p className={css.formHint}>
          当前生效地址：<code>{effective.apiBaseUrl}</code>
        </p>
      )}
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
      <div className={css.settingsActions}>
        {stored !== undefined && declared !== undefined && (
          <button
            type="button"
            onClick={() => {
              // Drop the override and let the deployment's own value apply again.
              clearBrowserSettings()
              onCancel?.()
            }}
          >
            清除本机覆盖，改用部署声明的地址
          </button>
        )}
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel}>返回</button>
        )}
      </div>
      <span className={css.formHint}>
        令牌保存在本机浏览器；account 模式使用面板登录的账号作为工作空间身份。
      </span>
    </div>
  )
}
