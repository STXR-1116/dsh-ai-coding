import { getToken } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import { authSecret } from '../../../../auth.ts'
import { handleTeamSkillProxy } from '../proxy-handler.ts'
import type { ProxyTokenReader } from '../proxy-handler.ts'

type RouteContext = { readonly params: Promise<{ readonly path: readonly string[] }> }

export const runtime = 'nodejs'

/** 从 Next Auth Session 读取上游 access token；测试注入替代实现。 */
const sessionTokenReader: ProxyTokenReader = async (request) => {
  const token = await getToken({ req: request, secret: authSecret })
  return token !== null && typeof token.accessToken === 'string' ? token.accessToken : undefined
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return handleTeamSkillProxy(request, context, sessionTokenReader)
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return handleTeamSkillProxy(request, context, sessionTokenReader)
}

export async function PUT(request: NextRequest, context: RouteContext): Promise<Response> {
  return handleTeamSkillProxy(request, context, sessionTokenReader)
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<Response> {
  return handleTeamSkillProxy(request, context, sessionTokenReader)
}

export async function DELETE(request: NextRequest, context: RouteContext): Promise<Response> {
  return handleTeamSkillProxy(request, context, sessionTokenReader)
}
