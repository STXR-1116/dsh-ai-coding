/**
 * 命令面板的搜索模型（蓝图 §6.2）：跨组织、项目、Agent、运行、资产、操作者
 * 与 request ID 七类来源做大小写不敏感的子串匹配；每条结果在执行前披露所需
 * 权限与影响范围。面板导航全部只读——不产生任何写操作。
 */

/** 面板搜索的一类来源。 */
export interface PaletteSourceRow {
  readonly id: string
  readonly label: string
}

/** 七类搜索来源（键与类别一一对应）。 */
export interface PaletteSources {
  readonly organizations: readonly PaletteSourceRow[]
  readonly projects: readonly PaletteSourceRow[]
  readonly agents: readonly PaletteSourceRow[]
  readonly runs: readonly PaletteSourceRow[]
  readonly assets: readonly PaletteSourceRow[]
  readonly operators: readonly PaletteSourceRow[]
  readonly requestIds: readonly PaletteSourceRow[]
}

/** 面板结果行。 */
export interface PaletteResult {
  readonly id: string
  readonly category:
    | '组织'
    | '项目'
    | 'Agent'
    | '运行'
    | '资产'
    | '操作者'
    | 'request ID'
  readonly label: string
}

/** 类别固定顺序（展示顺序，与来源键对应）。 */
const CATEGORY_ORDER: readonly { readonly category: PaletteResult['category']; readonly key: keyof PaletteSources }[] = [
  { category: '组织', key: 'organizations' },
  { category: '项目', key: 'projects' },
  { category: 'Agent', key: 'agents' },
  { category: '运行', key: 'runs' },
  { category: '资产', key: 'assets' },
  { category: '操作者', key: 'operators' },
  { category: 'request ID', key: 'requestIds' },
]

function matches(query: string, row: PaletteSourceRow): boolean {
  return row.label.toLowerCase().includes(query) || row.id.toLowerCase().includes(query)
}

/**
 * 跨七类来源搜索；空查询返回空集（不回显全量），大小写不敏感。
 * @param input - 查询词与各来源行。
 * @returns 按固定类别顺序排列的结果。
 */
export function buildPaletteResults(input: { readonly query: string; readonly sources: PaletteSources }): readonly PaletteResult[] {
  const query = input.query.trim().toLowerCase()
  if (query.length === 0) return []
  const results: PaletteResult[] = []
  for (const { category, key } of CATEGORY_ORDER) {
    for (const row of input.sources[key]) {
      if (matches(query, row)) results.push({ id: row.id, category, label: row.label })
    }
  }
  return results
}

/** 面板动作的执行前披露：所需权限与影响范围。 */
export interface PaletteActionDisclosure {
  readonly permission: string
  readonly impact: string
}

/**
 * 单条结果的执行前披露：面板导航全部只读，权限为管理面访问。
 * @param row - 面板结果行。
 * @returns 权限与影响范围文本。
 */
export function paletteActionDisclosure(row: PaletteResult): PaletteActionDisclosure {
  return {
    permission: `管理面权限（进入${row.category}视图）`,
    impact: '只读导航：查看详情，不修改任何状态',
  }
}
