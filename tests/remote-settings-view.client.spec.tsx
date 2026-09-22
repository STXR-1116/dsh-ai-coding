// @vitest-environment jsdom
/* 设置表单是**逃生口**，不只是首次配置页。
 *
 * 背景（实测的故障）：表单原先只在「什么都没配」时显示。于是无论配错的是部署声明的地址，
 * 还是浏览器里存过的旧地址，操作者**都再也回不到表单** —— 我上一轮为了防止「本地值盖住
 * 部署」而把表单的可达性绑死在 `settingsReady === false` 上，结果在另一侧造了同样的死结。
 * 用户遇到的是它的具体形态：进协作台报 `服务暂时不可用 / Failed to fetch`，而地址是旧夹具
 * 端口，页面上没有任何入口能改。
 *
 * 现在：表单可以从失败态打开（`PlatformSurface` 的 service-error 面板给「服务设置」入口），
 * 并支持两种退出方式 —— 改成一个能用的地址，或清除本机覆盖改用部署声明。
 *
 * 本文件钉住表单侧的那一半契约：预填当前生效值、覆盖存在时提供清除、可取消返回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RemoteSettingsView } from '../src/client/RemoteSettingsView.tsx'
import {
  PLATFORM_DEPLOYMENT_GLOBAL,
  WORKSPACE_DEPLOYMENT_GLOBAL,
} from '../src/deployment-contract.ts'
import { readBrowserSettings, writeBrowserSettings } from '../src/client/remote/settings.ts'

const scope = () => globalThis as unknown as Record<string, unknown>

function reset(): void {
  delete scope()[PLATFORM_DEPLOYMENT_GLOBAL]
  delete scope()[WORKSPACE_DEPLOYMENT_GLOBAL]
  localStorage.clear()
}

beforeEach(reset)
afterEach(() => {
  cleanup()
  reset()
  vi.restoreAllMocks()
})

/** Read one named input's current value. */
const valueOf = (name: string): string =>
  (document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value ?? ''

describe('首次配置：部署未声明时', () => {
  it('说明本部署未声明地址，且不提供「清除覆盖」', () => {
    render(<RemoteSettingsView />)
    expect(screen.getByText(/本部署未声明服务地址/u)).toBeTruthy()
    expect(screen.queryByText(/清除本机覆盖/u)).toBeNull()
    expect(valueOf('dsh-ai-coding-api-base-url')).toBe('')
  })
})

describe('覆盖编辑器：从失败态打开时', () => {
  it('预填当前生效的地址，而不是给一张空表单', () => {
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://deployment/v1', accessToken: 'dep-tok' }
    render(<RemoteSettingsView />)
    // 打开表单是为了修一个坏地址，因此必须看见坏地址本身。
    expect(valueOf('dsh-ai-coding-api-base-url')).toBe('http://deployment/v1')
    expect(valueOf('dsh-ai-coding-access-token')).toBe('dep-tok')
  })

  it('本机覆盖生效时，预填的是覆盖值（那才是当前生效的）', () => {
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://deployment/v1' }
    writeBrowserSettings({ apiBaseUrl: 'http://stale-local:63900/v1' })
    render(<RemoteSettingsView />)
    expect(valueOf('dsh-ai-coding-api-base-url')).toBe('http://stale-local:63900/v1')
    expect(screen.getByText(/http:\/\/stale-local:63900\/v1/u)).toBeTruthy()
  })

  it('提供「清除本机覆盖」并真的清除，然后返回工作台', () => {
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://deployment/v1' }
    writeBrowserSettings({ apiBaseUrl: 'http://stale-local:63900/v1' })
    const onCancel = vi.fn()
    render(<RemoteSettingsView onCancel={onCancel} />)
    fireEvent.click(screen.getByText(/清除本机覆盖/u))
    expect(readBrowserSettings()).toBeUndefined()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('部署未声明时不显示清除（没有可回退的部署值）', () => {
    writeBrowserSettings({ apiBaseUrl: 'http://local/v1' })
    render(<RemoteSettingsView onCancel={() => {}} />)
    expect(screen.queryByText(/清除本机覆盖/u)).toBeNull()
    expect(screen.getByText('返回')).toBeTruthy()
  })

  it('可以取消返回而不改动任何值', () => {
    writeBrowserSettings({ apiBaseUrl: 'http://local/v1' })
    const onCancel = vi.fn()
    render(<RemoteSettingsView onCancel={onCancel} />)
    fireEvent.click(screen.getByText('返回'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(readBrowserSettings()?.apiBaseUrl).toBe('http://local/v1')
  })

  it('保存后值被持久化（覆盖生效）', () => {
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://deployment/v1' }
    render(<RemoteSettingsView onCancel={() => {}} />)
    fireEvent.change(document.querySelector('input[name="dsh-ai-coding-api-base-url"]') as HTMLInputElement, {
      target: { value: 'http://fixed:4100/v1' },
    })
    fireEvent.submit(document.querySelector('form') as HTMLFormElement)
    expect(readBrowserSettings()?.apiBaseUrl).toBe('http://fixed:4100/v1')
  })
})
