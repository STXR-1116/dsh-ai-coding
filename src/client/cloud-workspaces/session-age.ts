/**
 * 会话时间的**紧凑相对格式**。
 *
 * 为什么不用原始时间串：所有者对照原生左栏指出「会话记录样式与原生的不一致」——
 * 原生显示的是「14分钟 / 24天」这种紧凑相对时间，而我们此前直接把服务端返回的
 * ISO 串（`2026-09-22T09:10:00Z`）摆在行尾，既长又不像原生。
 *
 * 措辞**照抄官方字典**（`@deepseek-ai/dsh-client-ui-*` 的 `time.*` 条目，随包产物里可见）：
 *   zh：刚刚 / {n}分钟 / {n}小时 / {n}天 / {n}个月 / {n}年
 *   en：now / {n}min / {n}h / {n}d / {n}mo / {n}y
 * 这里只做**阈值与替换**，文案全部来自调用方给的字典 —— 于是它可本地化、可单测。
 *
 * @module dsh-ai-coding/client/cloud-workspaces/session-age
 */

/** 相对时间用到的六条文案模板（`{n}` 会被替换成数字）。 */
export interface AgeLabels {
  /** < 1 分钟。 */
  readonly now: string
  /** < 1 小时。 */
  readonly minutes: string
  /** < 1 天。 */
  readonly hours: string
  /** < 30 天。 */
  readonly days: string
  /** < 12 个月。 */
  readonly months: string
  /** 其余。 */
  readonly years: string
}

/** 兜底文案（与官方 zh 字典一致）：拿不到 `t` 时用它，绝不退回原始 ISO 串。 */
export const AGE_LABELS_ZH: AgeLabels = {
  now: '刚刚',
  minutes: '{n}分钟',
  hours: '{n}小时',
  days: '{n}天',
  months: '{n}个月',
  years: '{n}年',
}

/** 一分钟、一小时、一天、一个月（按 30 天）、一年的毫秒数。 */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/**
 * 把 ISO 时间格式化成紧凑相对时间。
 * @param iso - 服务端返回的时间串。
 * @param labels - 文案模板（见 {@link AgeLabels}）。
 * @param now - 当前时间（毫秒）；默认取墙上时钟，测试传入固定值。
 * @returns 形如「刚刚」「14分钟」「24天」的文案；**时间串不可解析时原样返回**，不编造。
 */
export function compactAge(iso: string, labels: AgeLabels = AGE_LABELS_ZH, now: number = Date.now()): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  // 未来时间（时钟偏差）按"刚刚"处理，不显示负数。
  const elapsed = Math.max(0, now - parsed)
  const fill = (template: string, value: number): string => template.replace('{n}', String(value))
  if (elapsed < MINUTE) return labels.now
  if (elapsed < HOUR) return fill(labels.minutes, Math.floor(elapsed / MINUTE))
  if (elapsed < DAY) return fill(labels.hours, Math.floor(elapsed / HOUR))
  if (elapsed < MONTH) return fill(labels.days, Math.floor(elapsed / DAY))
  if (elapsed < YEAR) return fill(labels.months, Math.floor(elapsed / MONTH))
  return fill(labels.years, Math.floor(elapsed / YEAR))
}
