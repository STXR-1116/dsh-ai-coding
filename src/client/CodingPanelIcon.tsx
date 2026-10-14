import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 左栏 rail 上的「AI 编码工作台」面板图标。
 *
 * 官方契约（`dsh-client-ui-sidebar` 的 `contract/slots.d.ts`）：
 * `sidebar.panellist` 是 `kind: 'list'`，「Each list id addresses the matching main panel;
 * the sidebar owns the button and resolves its label from list metadata」——
 * 也就是说按钮由侧栏渲染，我们只提供图标与元数据，owner props 里给到 `size` 与 `active`。
 *
 * 图标用官方原语（不自己画）：`IconCodeOutline16`。
 * @param props - 侧栏给的尺寸与选中态。
 * @returns 图标元素。
 */
export function CodingPanelIcon({ size }: { readonly size?: number; readonly active?: boolean }) {
  return <IconCodeOutline16 size={size ?? 16} />
}
