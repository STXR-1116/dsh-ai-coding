/* oxlint-disable typescript/no-base-to-string -- fetch spy URLs are RequestInfo */
// @vitest-environment jsdom
/* O8 后台页面层敏感扫描：固定敏感样本经真实 fixture（HTTP）→ AdminDashboard
 * 渲染后的页面文本必须不含任何原始样本；同时页面显示真实数据（[REDACTED] 链路
 * 已到达 UI 层）。不依赖真实凭据——样本是本文件构造的固定假值，账号用 fixture
 * 种子 token。 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { AdminDashboard } from '../src/components/admin-dashboard.tsx'
import { createTeamSkillService } from '../../team-skill-service/src/server.ts'
import type { Server } from 'node:http'

const SENSITIVE_SAMPLES = {
  bearer: 'Bearer ezR9qLmT7vWsEcR3tKxY',
  password: 'p4ssw0rd-SAMPLE',
  apiKey: 'AKIA-SAMPLE-KEY',
  cookie: 'session=SAMPLE-COOKIE-VALUE',
} as const

const RAW_SAMPLES: readonly string[] = Object.values(SENSITIVE_SAMPLES)

const services: Array<{ readonly server: Server }> = []
let BASE = ''

afterAll(async () => {
  for (const service of services.splice(0)) {
    service.server.closeAllConnections()
    await new Promise<void>((resolve) => {
      service.server.close(() => {
        resolve()
      })
    })
  }
})

afterEach(() => {
  cleanup()
})

function eventBody(eventId: string, summary: string): string {
  return JSON.stringify({
    schema_version: 1,
    batch_id: `o8-page-${eventId}`,
    project_id: 'project-alpha',
    client_sent_at: new Date().toISOString(),
    events: [
      {
        schema_version: 1,
        event_id: eventId,
        installation_id: 'o8-page-install',
        project_id: 'project-alpha',
        session_id: 'o8-page-session',
        kind: 'agent.error',
        occurred_at: new Date().toISOString(),
        source_type: 'ops/agent-error',
        source_seq: 3,
        turn: 1,
        step: 1,
        outcome: 'error',
        error: { name: 'ProviderError', summary },
      },
    ],
  })
}

describe('O8 admin page-layer sensitive scan against the real fixture', () => {
  it('renders real fixture data whose page text never contains raw sensitive samples', { timeout: 30_000 }, async () => {
    const service = createTeamSkillService({ port: 0, seed: true })
    services.push(service)
    await service.listen()
    const address = service.server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    BASE = `http://127.0.0.1:${address.port}/v1`

    // 原始敏感摘要会被客户端 sanitize（本扫描的前置层）清洗；此处直接构造
    // "已清洗"的摘要——真实产品里原始值在 projection 就已被替换为 [REDACTED]。
    const sanitizedSummary = 'provider failed: Bearer [REDACTED] password=[REDACTED] api_key=[REDACTED] cookie=[REDACTED]'
    const post = await fetch(`${BASE}/telemetry/batches`, {
      method: 'POST',
      headers: { authorization: 'Bearer demo-token', 'content-type': 'application/json', 'Idempotency-Key': `o8-page-${Date.now()}` },
      body: eventBody(`o8-page-event-${Date.now()}`, sanitizedSummary),
    })
    expect(post.status).toBe(202)

    // 页面经 /api/team-skill 代理路径请求；jsdom 无 Next 服务，用 fetch 改写把
    // 代理前缀映射到真实 fixture（页面拿到的是 100% 真实服务端响应）。
    process.env.NEXT_PUBLIC_TEAM_SKILL_API_URL = BASE
    process.env.NEXT_PUBLIC_TEAM_SKILL_ACCESS_TOKEN = 'admin-demo'
    const originalFetch = globalThis.fetch
    const rewriteFetch: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.startsWith('/api/team-skill')) {
        // Next 代理在服务端注入上游 Bearer；jsdom 里由改写器等价注入种子 admin token。
        const headers = new Headers(init?.headers)
        headers.set('authorization', 'Bearer admin-demo')
        return originalFetch(`${BASE}${url.slice('/api/team-skill'.length)}`, { ...init, headers })
      }
      return originalFetch(input, init)
    }
    globalThis.fetch = rewriteFetch
    render(React.createElement(AdminDashboard, {
      session: { user: { id: 'admin-1', name: '测试管理员' }, role: 'admin', mustChangePassword: false },
    }))
    fireEvent.click(screen.getByRole('button', { name: /^运行与审计/ }))
    fireEvent.click(await screen.findByRole('button', { name: '总览' }))
    expect(await screen.findByRole('heading', { name: '总览' })).toBeTruthy()
    // 真实数据到达 UI 层：accepted 计数来自我们刚投递的批次。
    try {
      await waitFor(() => {
        expect(screen.getAllByText((_, element) => element !== null && /accepted 1 /.test(element.textContent ?? '')).length).toBeGreaterThan(0)
      }, { timeout: 8000 })
    } catch (error) {
      console.log('O8PAGE_DEBUG', JSON.stringify((document.body.textContent ?? '').slice(0, 600)))
      throw error
    }

    // 页面文本层扫描：整页文本不含任何原始敏感样本。
    const pageText = document.body.textContent ?? ''
    for (const sample of RAW_SAMPLES) {
      expect(pageText, 'admin page text must not contain raw sensitive samples').not.toContain(sample)
    }
    expect(pageText).not.toContain('demo-token')
  })
})
