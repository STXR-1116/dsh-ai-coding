/**
 * 文件预览 —— 云工作空间的**唯一**预览实现。
 *
 * ## 为什么抽出来
 *
 * 这段查看器分派（sandbox / Markdown / 图片 / 终端输出 / diff / 纯文本）原本长在
 * `CloudWorkspacesView` 里。新加的右栏「云文件」面板第一版**又手写了一个 `<pre>`**，
 * 于是同一个产品里出现两种预览质量 —— 所有者一眼看出来：「这个预览太简陋了，要跟原生的
 * 预览保持一致」。**同一种东西只留一份实现**，两边都渲染这个组件。
 *
 * ## 它为什么"像原生"
 *
 * Markdown 走的是官方客户端导出的 `MarkdownText`（`@deepseek-ai/dsh-client`），不是我们自己
 * 写的渲染器；HTML 走安全地板（`applyPreviewSecurity` + 只透传词表内 token 的 sandbox）。
 *
 * > 注：DSH 自带的**官方文档预览**（`dsh-client-ui-sidebar-documentpreview`）只认领
 * > `dsh-resource://file/**` 且 `canOpen` 限定 `scope === 'session'` 的地址，内容由 Host 的
 * > 组合文件系统（`ctx.fs`）读取。云文件是远端资源、不进那套地址体系，因此**复用的是渲染
 * > 原语**（`MarkdownText`、安全地板），而不是那个 tab 类型本身。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/FilePreview
 */

import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

import type { WorkspacePreview } from '../../workspace-types.ts'
import { applyPreviewSecurity, isolatedPreviewSandbox } from './preview-security.ts'
import { selectPreviewViewer } from './workspace-markers.ts'
import css from './FilePreview.module.css'

/**
 * Markdown 的本地化外壳。
 *
 * `MarkdownText` 要求 `labels`，且文档写明**新的身份会丢弃它流式渲染的缓存**，
 * 所以这个对象必须保持**引用稳定** —— 放在模块级，不要写进组件体内。
 */
const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
} as const

/** 预览 props。 */
export interface FilePreviewProps {
  /** 服务端返回的预览负载（`workspacePreview` 的 `value`）。 */
  readonly preview: WorkspacePreview
}

/**
 * 按内容类型渲染预览。
 * @param props - 预览负载。
 * @returns 对应的查看器。
 */
export function FilePreview({ preview }: FilePreviewProps) {
  const viewer = selectPreviewViewer(preview.kind, preview.contentType, preview.path)

  if (viewer === 'sandbox') {
    return (
      <iframe
        title="preview-iframe"
        className={css.frame}
        // 安全地板由工作台强制（设计 §5.2/2-3）：sandbox 只透传词表内 token（不透明 origin
        // 保持），CSP 地板先于服务端声明安装，声明只能收窄。
        sandbox={isolatedPreviewSandbox(preview.sandbox ?? [])}
        srcDoc={applyPreviewSecurity(preview.content ?? '', preview.csp ?? '')}
      />
    )
  }
  if (viewer === 'image') {
    return (
      <img
        className={css.image}
        alt={preview.path}
        src={`data:${preview.contentType};base64,${preview.contentBase64 ?? ''}`}
      />
    )
  }
  if (viewer === 'markdown') {
    return (
      <div className={css.text} data-viewer="markdown">
        <MarkdownText text={preview.content ?? ''} labels={MARKDOWN_LABELS} />
      </div>
    )
  }
  if (viewer === 'terminal') {
    return <pre className={css.text} data-viewer="terminal">{preview.content ?? ''}</pre>
  }
  if (viewer === 'diff') {
    return <pre className={css.text} data-viewer="diff">{preview.diff ?? preview.content ?? ''}</pre>
  }
  return <pre className={css.text} data-viewer={viewer}>{preview.content ?? ''}</pre>
}
