/** Copy for the single first-party AI Coding platform demo surface. */
export const zh = {
  'platform.name': '编程协作台',
  'platform.shortName': '协作台',
  'platform.open': '打开编程协作台',
  'platform.close': '关闭编程协作台',
  'platform.demo': '演示数据',
  'platform.offline': '服务端未连接',
} as const

/** English dictionary kept complete for the standard locale registry. */
export const en = {
  'platform.name': 'Coding Workspace',
  'platform.shortName': 'Workspace',
  'platform.open': 'Open coding workspace',
  'platform.close': 'Close coding workspace',
  'platform.demo': 'Demo data',
  'platform.offline': 'Server not connected',
} satisfies Record<keyof typeof zh, string>

/** Keys owned by this package's locale namespace. */
export type PlatformKey = keyof typeof zh

/** Locale namespace registered by the platform plugin. */
export const NS = 'aiCodingPlatform' as const
