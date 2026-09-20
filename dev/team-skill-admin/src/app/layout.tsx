import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AI 开放平台 · 团队 Skill 管理',
  description: '平台托管团队 Skill 的审核与发布管理后台',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Apply the stored theme/density before first paint so the shell never
  // flashes the wrong theme; defaults are light + comfortable (spec §2).
  const themeBootstrap = '(function(){var r=document.documentElement;var theme=\'light\';var density=\'comfortable\';try{var t=localStorage.getItem(\'dsh.appearance.theme\');var d=localStorage.getItem(\'dsh.appearance.density\');if(t===\'dark\')theme=\'dark\';else if(t===\'system\')theme=window.matchMedia(\'(prefers-color-scheme: dark)\').matches?\'dark\':\'light\';if(d===\'compact\')density=\'compact\'}catch(e){}r.setAttribute(\'data-theme\',theme);r.setAttribute(\'data-density\',density)})()'
  return (
    <html lang="zh-CN">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        {children}
      </body>
    </html>
  )
}
