/**
 * 让工作台右栏出现 —— 契约变更后的测试助手。
 *
 * ## 为什么需要它
 *
 * 所有者规格：**右侧是完整的主会话区**，只有预览文件时主会话区才让出右半。因此右栏
 * （Preview/Changes/Run 页签与其正文）**默认不存在**：`.columns` 上没有 `data-pane-open` 时，
 * 样式把整栏 `display: none`。
 *
 * ⚠️ 这条隐藏**在测试里真的生效**：`vitest.config.ts` 的 jsdom 项目开了 `css: true`，
 * 而 testing-library 的 `getByRole` 会跳过可访问性树里被隐藏的元素 —— 于是"右栏里的 tab"
 * 在默认态下查不到（实测一次性打红 8 个文件 / 32 条）。
 *
 * ## 为什么点的是头部按钮，而不是目录里的文件
 *
 * 第一版用"打开一个文件"来让右栏出现，结果在**真实 fixture** 那批测试上失败：那些工作空间是
 * **停止态**，文件树被禁用，点文件不会开预览。这暴露了设计缺口 —— 右栏默认不存在之后，
 * 「变更 / 运行」就**没有任何入口**了。于是工作台头部补了一个显式入口
 * （`aria-label="打开变更与运行面板"`），本助手点的就是它：不依赖工作空间状态，稳定可用。
 *
 * ## 为什么不用"把隐藏逻辑改松"来让测试通过
 *
 * 那正是 `AGENTS.md` 禁止的做法：测试会绿，但产品就不再是所有者要的形态。契约变了，就同步改测试。
 *
 * @module dsh-ai-coding/tests/helpers/open-cloud-pane
 */

import { fireEvent, screen, waitFor } from '@testing-library/react'

/** 工作台头部那个显式入口的无障碍名（与视图里的 `aria-label` 一致）。 */
const ENTRY_LABEL = '打开变更与运行面板'

/**
 * 打开右栏（停在它当前的页签上，默认 Preview）。
 * @throws 当入口按钮不存在，或点完之后右栏仍未出现。
 */
export async function openCloudPane(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: ENTRY_LABEL }))
  await waitFor(() => {
    if (document.querySelector('[data-pane-open]') === null) {
      throw new Error('右栏未出现：点击头部入口后 .columns 仍没有 data-pane-open')
    }
  })
}
