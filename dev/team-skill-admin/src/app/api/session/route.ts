import { auth } from '../../../auth.ts'

export async function GET(): Promise<Response> {
  let session
  try {
    session = await auth()
  } catch {
    return Response.json({ authenticated: false }, { status: 401 })
  }
  if (session === null) return Response.json({ authenticated: false }, { status: 401 })
  return Response.json({
    authenticated: true,
    user: session.user,
    role: session.role,
    must_change_password: session.mustChangePassword,
  })
}
