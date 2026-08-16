import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { NS } from './locales.ts'
import css from './ReadOnlyComposer.module.css'

/** Match token returned by the project read-only composer selector. */
export type ProjectReadOnlyMatch = 'project-read-only'

/** Full project read-only composer props. */
export type ReadOnlyComposerProps =
  PropsRuntime<'conversation.composer'>
  & { matched: ProjectReadOnlyMatch }
  & PropsLocale<typeof NS>

/**
 * Render the composer replacement for read-only project members.
 * @param props - composed chain props and collaboration locale.
 * @returns non-interactive read-only project status.
 */
export function ReadOnlyComposer({ t }: ReadOnlyComposerProps) {
  return (
    <div className={css.root} role="status">
      <div className={css.panel}>
        <span className={css.icon} aria-hidden><IconWarningOutline16 size={16} /></span>
        <span className={css.copy}>
          <strong>{t('readonly.title')}</strong>
          <span>{t('readonly.body')}</span>
        </span>
      </div>
    </div>
  )
}
