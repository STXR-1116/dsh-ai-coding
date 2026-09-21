// @vitest-environment jsdom
/* 部署声明契约：宿主把行配置注入页面，浏览器据此免去手工填写。
 *
 * 背景（实测）：0.1.5-rc.2 的客户端 runner **不向 fragment 下发行配置** —— 页面里有模块
 * 记录，但没有 apiBaseUrl / accessToken / stateDirectory 任何一个键。所以工作台原本只能
 * 让操作者在浏览器表单里手填部署值，而那是**部署属性**，本该在行配置里（手册：换部署该改
 * 的值必须是配置字段）。
 *
 * 现在每一行通过 webserver 的结构化注入表把自己的那一份写进 index（`{kind:'global'}`
 * 渲染成 `globalThis["<name>"] = <json>`，位于 head、早于所有模块脚本），浏览器在启动期
 * 同步读取。本文件钉住三件事：
 *
 * 1. 注入行的**安全策略**：URL 总是注入；令牌只在部署明确声明了「无登录」时才过桥；
 * 2. 浏览器侧**重新校验**页面来的值（它经过一个页面全局，不能被无条件信任）；
 * 3. **优先级**：部署声明胜过浏览器本地存的值 —— 否则一个过期的本地值会盖住部署，
 *    而设置面只在「都没配」时才显示，操作者将再也回不去表单。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PLATFORM_DEPLOYMENT_GLOBAL,
  WORKSPACE_DEPLOYMENT_GLOBAL,
  platformDeploymentInjection,
  readDeploymentDeclaration,
  workspaceDeploymentInjection,
} from '../src/deployment-contract.ts'
import {
  readBrowserSettings,
  readDeploymentSettings,
  resolveBrowserSettings,
  writeBrowserSettings,
} from '../src/client/remote/settings.ts'

const scope = () => globalThis as unknown as Record<string, unknown>

/** Clear both injected slices and the browser's stored settings. */
function reset(): void {
  delete scope()[PLATFORM_DEPLOYMENT_GLOBAL]
  delete scope()[WORKSPACE_DEPLOYMENT_GLOBAL]
  localStorage.clear()
}

beforeEach(reset)
afterEach(reset)

describe('宿主侧：注入行的构造与安全策略', () => {
  it('没有端点时不产生注入行，页面保持未配置（设置面仍是配置通道）', () => {
    expect(platformDeploymentInjection(undefined)).toBeUndefined()
    expect(platformDeploymentInjection({ apiBaseUrl: '' })).toBeUndefined()
    expect(workspaceDeploymentInjection(undefined)).toBeUndefined()
    expect(workspaceDeploymentInjection({})).toBeUndefined()
  })

  it('平台行注入 API 地址与（声明了才有的）平台令牌', () => {
    expect(platformDeploymentInjection({ apiBaseUrl: 'http://svc/v1' })).toEqual({
      kind: 'global',
      name: PLATFORM_DEPLOYMENT_GLOBAL,
      value: { apiBaseUrl: 'http://svc/v1' },
    })
    expect(platformDeploymentInjection({ apiBaseUrl: 'http://svc/v1', accessToken: 'tok' })).toEqual({
      kind: 'global',
      name: PLATFORM_DEPLOYMENT_GLOBAL,
      value: { apiBaseUrl: 'http://svc/v1', accessToken: 'tok' },
    })
  })

  it('工作空间行的固定令牌只在 static-token 模式下过桥', () => {
    const staticMode = workspaceDeploymentInjection({ apiBaseUrl: 'http://ws/v1', accessToken: 'ws-tok', authMode: 'static-token' })
    expect(staticMode).toEqual({
      kind: 'global',
      name: WORKSPACE_DEPLOYMENT_GLOBAL,
      value: { apiBaseUrl: 'http://ws/v1', accessToken: 'ws-tok', authMode: 'static-token' },
    })
    // account 模式按用户登录，宿主令牌没有理由进入页面。
    const accountMode = workspaceDeploymentInjection({ apiBaseUrl: 'http://ws/v1', accessToken: 'ws-tok', authMode: 'account' })
    expect(accountMode).toEqual({
      kind: 'global',
      name: WORKSPACE_DEPLOYMENT_GLOBAL,
      value: { apiBaseUrl: 'http://ws/v1', authMode: 'account' },
    })
    // 未声明模式时同样不注入令牌。
    expect(workspaceDeploymentInjection({ accessToken: 'ws-tok' })).toBeUndefined()
  })
})

describe('浏览器侧：读取与重新校验', () => {
  it('合并两行各自的切片', () => {
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://svc/v1', accessToken: 'tok' }
    scope()[WORKSPACE_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://ws/v1', accessToken: 'ws-tok', authMode: 'static-token' }
    expect(readDeploymentDeclaration()).toEqual({
      apiBaseUrl: 'http://svc/v1',
      accessToken: 'tok',
      workspaceApiBaseUrl: 'http://ws/v1',
      workspaceAccessToken: 'ws-tok',
      authMode: 'static-token',
    })
  })

  it('缺平台端点即视为未声明：浏览器每一次读取都先经过平台客户端', () => {
    scope()[WORKSPACE_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://ws/v1' }
    expect(readDeploymentDeclaration()).toBeUndefined()
  })

  it('页面上的畸形值降级为「未配置」，而不是拿它去构造客户端', () => {
    for (const bogus of [undefined, null, 42, 'text', [], { apiBaseUrl: 7 }, { apiBaseUrl: '' }]) {
      scope()[PLATFORM_DEPLOYMENT_GLOBAL] = bogus
      expect(readDeploymentDeclaration()).toBeUndefined()
    }
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://svc/v1' }
    scope()[WORKSPACE_DEPLOYMENT_GLOBAL] = { authMode: 'nonsense', apiBaseUrl: 12 }
    expect(readDeploymentDeclaration()).toEqual({ apiBaseUrl: 'http://svc/v1' })
  })
})

describe('优先级：部署声明胜过浏览器本地值', () => {
  it('两者都在时用部署声明（否则过期本地值会盖住部署且无路回退）', () => {
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://deployment/v1' }
    writeBrowserSettings({ apiBaseUrl: 'http://stale-local/v1' })
    expect(resolveBrowserSettings()?.apiBaseUrl).toBe('http://deployment/v1')
  })

  it('部署未声明时回退到本地值（设置面仍是裸部署的配置通道）', () => {
    writeBrowserSettings({ apiBaseUrl: 'http://local/v1', accessToken: 'local-tok' })
    expect(readDeploymentSettings()).toBeUndefined()
    expect(resolveBrowserSettings()).toMatchObject({ apiBaseUrl: 'http://local/v1', accessToken: 'local-tok' })
  })

  it('都没有时为 undefined：工作台打开设置面而不是假装就绪', () => {
    expect(resolveBrowserSettings()).toBeUndefined()
    expect(readBrowserSettings()).toBeUndefined()
  })

  it('工作空间端点未声明时跟随平台端点（沿用既有解析规则）', () => {
    scope()[PLATFORM_DEPLOYMENT_GLOBAL] = { apiBaseUrl: 'http://svc/v1' }
    const resolved = resolveBrowserSettings()
    expect(resolved?.workspaceApiBaseUrl).toBe('http://svc/v1')
  })
})
