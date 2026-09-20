/** Compact sidebar action that opens the first-party platform demo. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import css from './PlatformSurface.module.css'

/** Injected action shared with the frame overlay. */
export interface PlatformEntryInjected {
  /** Show the platform surface. */
  onOpen: () => void
}

/** Full props for the root-scoped sidebar action. */
export type PlatformEntryProps = PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>
  & PlatformEntryInjected

/** Render the wide label or the compact rail icon supplied by the sidebar. */
export function PlatformEntry({ wide, onOpen, t }: PlatformEntryProps) {
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
