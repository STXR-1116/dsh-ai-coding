/** Compact sidebar action that opens the first-party platform demo. */
import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import type { PlatformKey } from './locales.ts'
import { SlotBoundary } from './slot-boundary.tsx'
import css from './PlatformSurface.module.css'

/** Injected action shared with the frame overlay. */
export interface PlatformEntryInjected {
  /** Show the platform surface. */
  onOpen: () => void
  /** 侧栏折叠态（官方席位 owner props 给的；宽态显示文字、窄态显示图标）。 */
  wide?: boolean
  /** 本地化函数：由 slot runtime 按注册时的 `locale` 注入。 */
  t: (key: PlatformKey) => string
}

/** Full props for the root-scoped sidebar action. */
export type PlatformEntryProps = PlatformEntryInjected

/** The labelled, styled action; everything that could fail at render lives here. */
function StyledEntry({ wide, onOpen, t }: PlatformEntryProps) {
  return (
    <button
      type="button"
      className={css.sidebarEntry}
      aria-label={t('platform.open')}
      title={wide ? undefined : t('platform.open')}
      onClick={onOpen}
    >
      <IconSparkle16 size={wide ? 15 : 18} className={css.sidebarEntryIcon} />
      {wide && <span>{t('platform.shortName')}</span>}
    </button>
  )
}

/**
 * Dependency-free launcher used if the styled action fails to render.
 *
 * It reads nothing this plugin owns: no locale lookup, no icon, no CSS module —
 * so it cannot fail the way the styled action did, and the operator keeps a way
 * into the workbench. The accessible name matches the styled action's, so both
 * lookups and muscle memory keep working.
 */
function PlainEntry({ onOpen }: Pick<PlatformEntryProps, 'onOpen'>) {
  return (
    <button
      type="button"
      aria-label="打开编程协作台 / Open coding workspace"
      title="打开编程协作台 / Open coding workspace"
      onClick={onOpen}
    >
      协作台
    </button>
  )
}

/**
 * Render the wide label or the compact rail icon supplied by the sidebar.
 *
 * Wrapped in {@link SlotBoundary}: the renderer retires a slot entry that throws
 * for the rest of the page's life, which would take the only way into the
 * workbench with it.
 */
export function PlatformEntry(props: PlatformEntryProps) {
  return (
    <SlotBoundary slot="sidebar.footer.action" fallback={<PlainEntry onOpen={props.onOpen} />}>
      <StyledEntry {...props} />
    </SlotBoundary>
  )
}
