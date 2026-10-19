/**
 * 生成 A/B/C 三个接管方案的左栏对照图（HTML），再用 build/screenshot.mjs 截成 PNG。
 *
 * 版式照所有者 2026-10-19 的截图：
 *   顶栏（含「云工作空间 · 已连接」标志）／左栏 240px／中央会话区。
 * 三张图只在**左栏**不同，并用红框 + 标注说明每一块归谁。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const options = [
  {
    id: 'a',
    title: '方案 A：维持现状（只替换 sidebar.workspaces）',
    subtitle: '与所有者最初的四条标注一致：标注的那段区域已换成后端来的会话记录 + 文件列表。',
    nativeTop: true,
    nativePanel: true,
    newSession: true,
    note: '左栏上半仍是原生外壳的（新会话 / 插件 / 自动化任务）。',
  },
  {
    id: 'b',
    title: '方案 B：再遮蔽 sidebar.panellist（左栏整块归我们）',
    subtitle: '同一套遮蔽机制、退出照样还原；把「插件 / 自动化任务」那一块也换成我们的内容。',
    nativeTop: false,
    nativePanel: false,
    newSession: true,
    note: '替换后放什么需要你定：此图按「会话记录 + 文件列表占满该区」画。',
  },
  {
    id: 'c',
    title: '方案 C：B + 去掉「新会话」按钮',
    subtitle: '最彻底的一版。「新会话」可能不是席位，只能用 CSS 隐藏 —— 需先核实再动手。',
    nativeTop: false,
    nativePanel: false,
    newSession: false,
    note: '「新会话」按钮一旦不是席位，隐藏它属于 CSS 手段（本仓踩过连带影响按角色查询的坑）。',
  },
]

/** 生成一张图的 HTML。 */
function page(option) {
  const newSession = option.newSession
    ? `<div class="btn-new">＋ 新会话</div>`
    : `<div class="btn-new gone">＋ 新会话<em>（本方案去掉）</em></div>`

  const nativeRows = option.nativePanel
    ? `<div class="row native"><span>🧩</span>插件</div>
       <div class="row native"><span>⏱</span>自动化任务</div>
       <div class="annot right">原生：sidebar.panellist</div>`
    : `<div class="annot right removed">已遮蔽：sidebar.panellist</div>`

  const ours = `
    <div class="section">
      <div class="section-title">会话记录</div>
      <div class="rec"><span>联调记录：云工作空间状态序列</span><span class="age">27 天</span></div>
      <div class="rec"><span>初始化与依赖安装</span><span class="age">27 天</span></div>
    </div>
    <div class="section">
      <div class="section-title">文件列表</div>
      <div class="tree">
        <div class="t0">▾ 工程目录 <em>main</em></div>
        <div class="t1">▸ assets</div>
        <div class="t1">▸ docs</div>
        <div class="t1">▸ src</div>
        <div class="t1 file">hostile.html</div>
        <div class="t1 file">index.html</div>
        <div class="t1 file">README.md</div>
      </div>
    </div>`

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${option.title}</title>
<style>
  :root {
    --bg: #131316; --surface: #1a1a1e; --surface-2: #202026; --line: #2a2a31;
    --text: #e8e8ea; --muted: #9a9aa2; --faint: #6e6e78;
    --accent: #4ea1ff; --ours: #38d39f; --danger: #ff5c5c;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0c; color: var(--text);
         font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .title { padding: 18px 24px 6px; }
  .title h1 { margin: 0 0 4px; font-size: 17px; }
  .title p { margin: 0; color: var(--muted); font-size: 12.5px; }
  .frame { margin: 14px 24px 24px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .topbar { display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 14px;
            background: var(--surface); border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .chip { padding: 2px 8px; border: 1px solid var(--line); border-radius: 6px; }
  .badge { margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
           padding: 2px 9px; border: 1px solid #2f6b52; border-radius: 999px;
           background: #16241d; color: #7fe0b0; font-size: 11.5px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ours); }
  .body { display: grid; grid-template-columns: 250px 1fr; min-height: 560px; }
  .side { background: var(--surface); border-right: 1px solid var(--line); padding: 10px 10px 12px; }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
  .brand b { color: var(--text); font-size: 13px; letter-spacing: .5px; }
  .btn-new { padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px;
             background: var(--surface-2); font-size: 12.5px; color: var(--text); margin-bottom: 10px; }
  .btn-new.gone { opacity: .35; border-style: dashed; }
  .btn-new em { color: var(--danger); font-style: normal; font-size: 11px; margin-left: 6px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px;
         font-size: 12.5px; color: var(--muted); }
  .row.native { border: 1px dashed #3a3a44; }
  .section { margin-top: 12px; }
  .section-title { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
  .rec { display: flex; justify-content: space-between; gap: 8px; padding: 4px 6px;
         border-radius: 6px; background: var(--surface-2); margin-bottom: 3px; font-size: 12px; }
  .rec span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .age { flex: none; color: var(--faint); }
  .tree { font-size: 12px; color: var(--muted); }
  .t0 { color: var(--text); margin-bottom: 3px; }
  .t0 em { color: var(--faint); font-style: normal; }
  .t1 { padding-left: 14px; }
  .t1.file { color: #7fb2ff; }
  .foot { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 8px; }
  .foot .row { padding: 5px 8px; }
  .center { padding: 22px 26px; background: var(--bg); }
  .center h2 { margin: 0 0 10px; font-size: 20px; }
  .center p { color: var(--muted); margin: 0 0 14px; }
  .bubble { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px;
            background: var(--surface); color: var(--muted); }
  .annot { display: inline-block; margin: 6px 0 0; padding: 2px 8px; border: 1px solid var(--danger);
           border-radius: 6px; color: #ffb3b3; font-size: 11px; background: #2a1414; }
  .annot.right { margin-left: 4px; }
  .annot.ours { border-color: #2f6b52; color: #8fe3bd; background: #14251d; }
  .annot.removed { border-color: #4a4a55; color: var(--faint); background: #1b1b20; }
  .legend { margin: 0 24px 18px; color: var(--muted); font-size: 12px; }
  .legend b { color: var(--text); }
  .note { margin: 0 24px 24px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
          background: var(--surface); color: var(--muted); font-size: 12.5px; }
</style></head><body>
  <div class="title">
    <h1>${option.title}</h1>
    <p>${option.subtitle}</p>
  </div>
  <div class="frame">
    <div class="topbar">
      <span class="chip">探索未至之境</span><span class="chip">预览版</span>
      <span class="chip">deepseek/deepseek-v4.1-flash</span>
      <span class="badge"><span class="dot"></span>云工作空间 · 已连接</span>
    </div>
    <div class="body">
      <div class="side">
        <div class="brand"><span>◈</span><b>deepseek</b> HARNESS</div>
        ${newSession}
        ${nativeRows}
        ${ours}
        <div class="annot ours">以下两块是我们的：会话记录 + 文件列表</div>
        <div class="foot">
          <div class="row">⋯ 更多</div>
          <div class="row">退出云工作空间</div>
          <div class="row">✦ 协作台</div>
          <div class="row">⚙ 设置</div>
        </div>
      </div>
      <div class="center">
        <h2>从权限范围内的资产开始协作</h2>
        <p>中央始终是外壳的原生会话区（我们只换左栏与标题栏标志）。</p>
        <div class="bubble">会话内容来自后端（当前为占位；§3.1 mock 之后会有真实内容）。</div>
      </div>
    </div>
  </div>
  <div class="legend">
    红框标注 = <b>归属说明</b>；绿色 = 我们的内容；灰色虚线 = 已被遮蔽/去掉的原生元素。
  </div>
  <div class="note">${option.note}</div>
</body></html>`
}

const dir = join(process.cwd(), 'docs', 'mockups')
for (const option of options) {
  const file = join(dir, `takeover-${option.id}.html`)
  writeFileSync(file, page(option))
  console.log(`✓ ${file}`)
}
