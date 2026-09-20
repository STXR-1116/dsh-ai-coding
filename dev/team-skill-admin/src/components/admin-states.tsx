// Shared page-state panels. Cloud workspace pages render the same loading and
// empty states as the dashboard pages, so the markup lives in one module
// (cloud-workspace-pages cannot import from admin-dashboard: that import would
// be circular).
import { Library } from 'lucide-react'

/** First load renders skeleton rows (design spec §5); text keeps the state readable without color. */
export function Loading() {
  return (
    <section className="state-panel" data-state="loading" role="status" aria-busy="true">
      <div className="skeleton-rows" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map(index => (
          <div key={index} className="skeleton-row" />
        ))}
      </div>
      <h2>正在读取服务端数据</h2>
      <p>页面不会使用本地成功数据替代服务端状态。</p>
    </section>
  )
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="empty" data-state="empty" role="status">
      <Library size={20} />
      <span>{text}</span>
    </div>
  )
}
