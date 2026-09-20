import { auth } from '../auth.ts'
import { AdminDashboard, AdminLoginPage, AdminPasswordChangePage } from '../components/admin-dashboard.tsx'

export default async function Page() {
  try {
    const session = await auth()
    if (session === null) return <AdminLoginPage clearStaleSession />
    if (session.mustChangePassword) return <AdminPasswordChangePage username={session.user.email ?? session.user.name ?? ''} />
    return <AdminDashboard session={session} />
  } catch {
    // Auth.js rejects when a session cookie was signed with a previous local secret.
    return <AdminLoginPage clearStaleSession />
  }
}
