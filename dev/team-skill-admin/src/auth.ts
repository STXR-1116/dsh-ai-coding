import NextAuth, { type DefaultSession } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { refreshServiceSessionOnce } from './auth-session.ts'

type AccountRole = 'admin' | 'manager' | 'member'

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user']
    role: AccountRole
    mustChangePassword: boolean
  }

  interface User {
    role: AccountRole
    mustChangePassword: boolean
    accessToken: string
    refreshToken: string
    expiresAt: number
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId?: string
    role?: AccountRole
    mustChangePassword?: boolean
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

export const serviceBaseUrl = (): string | undefined => {
  const value = process.env.TEAM_SKILL_SERVICE_URL?.trim()
  if (value === undefined || value.length === 0) return undefined
  return value.replace(/\/$/u, '')
}

/**
 * 上游可选拆分：账号/登录仍走 TEAM_SKILL_SERVICE_URL（AI Coding 后端或其本地
 * fixture）；设置 MEMORY_SERVICE_URL 后，/v3/project-memory/* 数据面请求改指
 * 独立记忆库服务；未设置时由代理显式返回 MemoryService 不可用。
 */
export const memoryServiceBaseUrl = (): string | undefined => {
  const value = process.env.MEMORY_SERVICE_URL?.trim()
  if (value === undefined || value.length === 0) return undefined
  return value.replace(/\/$/u, '')
}

export const authSecret = process.env.AUTH_SECRET?.trim() || 'local-team-skill-admin-auth-secret'

export const { handlers, auth } = NextAuth({
  secret: authSecret,
  trustHost: true,
  session: { strategy: 'jwt' },
  providers: [
    Credentials({
      name: '账号密码',
      credentials: {
        username: { label: '用户名或邮箱', type: 'text' },
        password: { label: '密码', type: 'password' },
      },
      async authorize(credentials) {
        const baseUrl = serviceBaseUrl()
        const username = typeof credentials.username === 'string' ? credentials.username.trim() : ''
        const password = typeof credentials.password === 'string' ? credentials.password : ''
        if (baseUrl === undefined || username.length === 0 || password.length === 0) return null
        const response = await fetch(`${baseUrl}/auth/login`, {
          method: 'POST',
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
        if (!response.ok) return null
        const value: unknown = await response.json()
        if (
          !isRecord(value) ||
          !Object.hasOwn(value, 'data') ||
          (typeof value.code !== 'number' && typeof value.code !== 'string') ||
          typeof value.message !== 'string' ||
          typeof value.request_id !== 'string'
        ) return null
        const data = value.data
        if (!isRecord(data) || !isRecord(data.user)) return null
        const user = data.user
        const role = isRecord(user) && isRole(user.global_role) ? user.global_role : undefined
        const accessToken = typeof data.access_token === 'string' ? data.access_token : undefined
        const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : undefined
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined
        if (accessToken === undefined || refreshToken === undefined || expiresIn === undefined || role === undefined) return null
        return {
          id: stringValue(user.user_id),
          name: stringValue(user.display_name),
          email: stringValue(user.email),
          role,
          mustChangePassword: data.must_change_password === true,
          accessToken,
          refreshToken,
          expiresAt: Date.now() + expiresIn * 1000,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      const candidate: unknown = user
      if (
        isRecord(candidate) &&
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.email === 'string' &&
        isRole(candidate.role) &&
        typeof candidate.mustChangePassword === 'boolean' &&
        typeof candidate.accessToken === 'string' &&
        typeof candidate.refreshToken === 'string' &&
        typeof candidate.expiresAt === 'number'
      ) {
        token.userId = candidate.id
        token.name = candidate.name
        token.email = candidate.email
        token.role = candidate.role
        token.mustChangePassword = candidate.mustChangePassword
        token.accessToken = candidate.accessToken
        token.refreshToken = candidate.refreshToken
        token.expiresAt = candidate.expiresAt
        return token
      }
      if (typeof token.expiresAt === 'number' && token.expiresAt > Date.now() + 30_000) return token
      if (typeof token.refreshToken !== 'string') return token
      const baseUrl = serviceBaseUrl()
      if (baseUrl === undefined) return token
      const refreshed = await refreshServiceSessionOnce(baseUrl, token.refreshToken)
      if (refreshed === undefined) return {}
      return {
        ...token,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        mustChangePassword: refreshed.mustChangePassword,
        role: refreshed.role,
      }
    },
    session({ session, token }) {
      session.user.id = typeof token.userId === 'string' ? token.userId : (token.sub ?? '')
      session.user.name = typeof token.name === 'string' ? token.name : null
      if (typeof token.email === 'string') session.user.email = token.email
      session.role = isRole(token.role) ? token.role : 'member'
      session.mustChangePassword = token.mustChangePassword === true
      return session
    },
  },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function isRole(value: unknown): value is AccountRole {
  return value === 'admin' || value === 'manager' || value === 'member'
}
