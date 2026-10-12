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
 * 正文用的就是**官方那批原语**：代码走 `CodeBlock`（同一个 shiki 高亮器，自带语言表头、
 * 行号与复制按钮），Markdown 走 `MarkdownText`，HTML 走安全地板
 * （`applyPreviewSecurity` + 只透传词表内 token 的 sandbox）。
 *
 * > 注：DSH 自带的**官方文档预览**（`dsh-client-ui-sidebar-documentpreview`）由这些原语组装而成，
 * > 但它的正文实现（`lib/client/code/CodeBody`）是**包的内部模块**，`/client` 入口只导出插件主体，
 * > 深度导入不在 `exports` 里 —— 所以复用的是**原语**，而不是那个包的正文。
 * > 另外它只认领 `dsh-resource://file/**` 且 `canOpen` 限定 `scope === 'session'` 的地址、内容由 Host 的
 * > 组合文件系统（`ctx.fs`）读取；云文件是远端资源、不进那套地址体系。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/FilePreview
 */

import { CodeBlock, MarkdownText, fileExtension } from '@deepseek-ai/dsh-client-ui-primitives'

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

/** 复制按钮的两段文案（`CodeBlock` 由调用方提供本地化，该包本身不含文案）。 */
const COPY_LABELS = { copyLabel: '复制', copiedLabel: '已复制' } as const

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
    return (
      <div className={css.code} data-viewer="terminal">
        <CodeBlock code={preview.content ?? ''} lang="shellsession" lineNumbers {...COPY_LABELS} />
      </div>
    )
  }
  if (viewer === 'diff') {
    // 服务端给的是 unified diff 文本；shiki 的 `diff` 语法正好按 +/- 着色，
    // 所以不必自己解析成 DiffBlock 需要的结构化 hunk。
    return (
      <div className={css.code} data-viewer="diff">
        <CodeBlock code={preview.diff ?? preview.content ?? ''} lang="diff" lineNumbers {...COPY_LABELS} />
      </div>
    )
  }
  // 其余按**文件扩展名**提示语法（契约：`lang` 不认识就退化为纯文本，因此传扩展名是安全的）。
  // 这条路径要承担"跟原生一致"：官方预览正文用的就是这个 `CodeBlock`（语言表头 + 行号 + 复制），
  // 而组装它的那个包（`dsh-client-ui-sidebar-documentpreview`）只有内部模块，不可导入。
  //
  // `data-viewer` 是**对外可观察的标记**（测试与排查都按它认查看器），换实现时不能丢 ——
  // `CodeBlock` 只收 `className`，所以标记包在它外面这一层。
  return (
    <div className={css.code} data-viewer={viewer}>
      <CodeBlock code={preview.content ?? ''} lang={fileExtension(preview.path)} lineNumbers {...COPY_LABELS} />
    </div>
  )
}
