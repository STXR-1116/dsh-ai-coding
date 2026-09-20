// 2-3「HTML 预览安全」模型层验收（蓝图 §5.2）。
//
// 异常矩阵：
//   缺失       —— 服务端声明空/宽松 CSP 时工作台安全地板必须仍然安装（空策略
//                 等于浏览器不限制，不得作为安全边界）。
//   越权 token —— allow-same-origin 无论是否伴随 allow-scripts 都不得存活
//                 （不透明 origin 是父页面 DOM/存储/凭据隔离的来源）；
//                 allow-top-navigation/allow-popups/allow-modals/
//                 allow-storage-access-by-user-activation 等词表外 token
//                 一律丢弃；不发明未声明的合法 token。
//   边界       —— 声明为空 → 应用为空；输出 token 顺序按词表冻结，与声明
//                 顺序无关（同一声明集合必然得到同一属性值）。
//   资源白名单 —— 地板 CSP 只放行内联脚本/样式与 data: 图片/字体/媒体；
//                 connect-src/object-src/frame-src/form-action/base-uri 全
//                 'none'；白名单不含通配符、http(s): 与 file:（本地文件）。
//   父页面     —— 剥离 allow-same-origin + 丢弃 allow-top-navigation 后，
//                 框内文档无法触达嵌入页 DOM，也无法导航嵌入页。
//   内部 API   —— connect-src 'none' 断开 fetch/XHR/beacon（token 外带通道）。
//   下游失败   —— 服务端声明策略只能收窄不能放宽：地板 meta 先安装、声明
//                 meta 后安装，两者共存由浏览器取交集；声明值经属性转义，
//                 含引号/尖括号的策略不会逃逸出 meta 标签。
import { describe, expect, it } from 'vitest'
import {
  PREVIEW_CSP_FLOOR,
  PREVIEW_SANDBOX_TOKENS,
  applyPreviewSecurity,
  isolatedPreviewSandbox,
} from '../src/client/cloud-workspaces/preview-security.ts'

describe('2-3 sandbox 地板', () => {
  it('allow-same-origin 无论何种组合都不得存活', () => {
    expect(isolatedPreviewSandbox(['allow-scripts', 'allow-same-origin'])).toBe('allow-scripts')
    expect(isolatedPreviewSandbox(['allow-same-origin'])).toBe('')
  })

  it('词表外与危险 token 一律丢弃，合法 token 按词表顺序冻结', () => {
    expect(PREVIEW_SANDBOX_TOKENS).toEqual(['allow-scripts', 'allow-forms'])
    expect(isolatedPreviewSandbox([
      'allow-popups', 'allow-forms', 'allow-top-navigation', 'allow-scripts',
      'allow-modals', 'allow-storage-access-by-user-activation',
    ])).toBe('allow-scripts allow-forms')
  })

  it('声明为空应用为空，不发明 token', () => {
    expect(isolatedPreviewSandbox([])).toBe('')
  })
})

describe('2-3 CSP 地板', () => {
  it('地板策略只放行内联与 data:，网络/对象/表单/基准全关断', () => {
    expect(PREVIEW_CSP_FLOOR).toContain("default-src 'none'")
    expect(PREVIEW_CSP_FLOOR).toContain("connect-src 'none'")
    expect(PREVIEW_CSP_FLOOR).toContain("object-src 'none'")
    expect(PREVIEW_CSP_FLOOR).toContain("frame-src 'none'")
    expect(PREVIEW_CSP_FLOOR).toContain("form-action 'none'")
    expect(PREVIEW_CSP_FLOOR).toContain("base-uri 'none'")
    expect(PREVIEW_CSP_FLOOR).toContain('img-src data:')
    expect(PREVIEW_CSP_FLOOR).not.toMatch(/\*/u)
    expect(PREVIEW_CSP_FLOOR).not.toMatch(/https?:/u)
    expect(PREVIEW_CSP_FLOOR).not.toMatch(/file:/u)
  })

  it('服务端声明空/宽松 CSP 时地板仍然安装，声明只能收窄', () => {
    for (const declared of ['', 'default-src *'] as const) {
      const document = applyPreviewSecurity('<p>正文</p>', declared)
      expect(document).toContain(PREVIEW_CSP_FLOOR)
      const floorAt = document.indexOf(PREVIEW_CSP_FLOOR)
      const declaredAt = document.indexOf(declared)
      if (declared !== '') {
        expect(declaredAt).toBeGreaterThan(-1)
        expect(floorAt).toBeLessThan(declaredAt)
      }
    }
  })

  it('声明策略经属性转义，不逃逸 meta 标签', () => {
    const document = applyPreviewSecurity('<p>正文</p>', 'script-src "evil"><script>')
    expect(document).toContain('content="script-src &quot;evil&quot;&gt;&lt;script&gt;"')
    expect(document.indexOf('<script>')).toBe(document.lastIndexOf('<script>'))
  })

  it('有 head 插入 head 首位，无 head 建 head，纯片段包全文档', () => {
    const withHead = applyPreviewSecurity('<html><head><title>t</title></head><body>x</body></html>', '')
    expect(withHead.indexOf(PREVIEW_CSP_FLOOR)).toBeLessThan(withHead.indexOf('<title>'))
    const withHtml = applyPreviewSecurity('<html><body>x</body></html>', '')
    expect(withHtml).toContain('<head>')
    const fragment = applyPreviewSecurity('<p>x</p>', '')
    expect(fragment).toContain('<!DOCTYPE html>')
    expect(fragment).toContain('<body><p>x</p></body>')
  })
})

describe('2-3 预览文档安全头安装（未闭合标签与片段）', () => {
  it('在已有 head 的文档里把 meta 装进 head 内', () => {
    const html = '<html><head><title>t</title></head><body>x</body></html>'
    const out = applyPreviewSecurity(html, '')
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('http-equiv'))
  })

  it('有 html 但无 head 时补一个 head', () => {
    const out = applyPreviewSecurity('<html lang="zh"><body>x</body></html>', '')
    expect(out).toContain('<head>')
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('<body>'))
  })

  it('裸片段包成完整文档', () => {
    const out = applyPreviewSecurity('<p>片段</p>', '')
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out).toContain('<p>片段</p>')
  })

  it('标签未闭合时不把 meta 插进未闭合标签，整体包裹', () => {
    // 有开无闭的场景下 head 分支与 html 分支都必须落空。
    const unclosedHead = applyPreviewSecurity('<head', '')
    expect(unclosedHead.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(unclosedHead).toContain('<head>')
    const unclosedHtml = applyPreviewSecurity('<html lang="zh"', '')
    expect(unclosedHtml.startsWith('<!DOCTYPE html>')).toBe(true)
  })
})
