import { useEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14, IconGlobeOutline14, IconLoadingOutline16,
  IconUserOutline16, IconWarningOutline16, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  CollaborationSnapshot, CollaborationVisibility, ConversationParticipant,
} from './collaboration-client.ts'
import type { NS } from './locales.ts'
import css from './ConversationShareAction.module.css'

/** Registration-side collaboration data and actions for one session header. */
export interface ConversationShareInjected {
  hooks: {
    /** Shared Gateway collaboration snapshot, bound as useCollaboration. */
    collaboration: HostObservable<CollaborationSnapshot>
  }
  /** Load this requested session's effective collaboration detail. */
  load: () => Promise<void>
  /** Revalidate this requested session's collaboration detail. */
  refresh: () => Promise<void>
  /** Change this requested session root's visibility. */
  setVisibility: (visibility: CollaborationVisibility) => Promise<void>
}

/** Full conversation sharing header-action props. */
export type ConversationShareActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<ConversationShareInjected>
  & PropsLocale<typeof NS>

function participantLabel(
  participant: ConversationParticipant,
  contributions: (count: number) => string,
) {
  return (
    <span className={css.participantText}>
      <span className={css.participantName}>{participant.displayName}</span>
      <span className={css.participantMeta}>{contributions(participant.contributionCount)}</span>
    </span>
  )
}

/**
 * Render current root visibility, creator, participants, and visibility controls.
 * @param props - composed session-header slot props.
 * @returns project collaboration trigger, or null in personal scope.
 */
export function ConversationShareAction({
  sessionId, useCollaboration, useSession, load, refresh, setVisibility, t,
}: ConversationShareActionProps) {
  const state = useCollaboration(snapshot => snapshot)
  const tailNodeSeq = useSession((snapshot) => {
    const tail = snapshot.nodes[snapshot.nodes.length - 1]
    return tail?.seq
  })
  const previousTailNodeSeq = useRef(tailNodeSeq)
  const [open, setOpen] = useState(false)
  const projectScoped = state.context?.scope.kind === 'project'
  const detailState = state.conversations[sessionId]

  useEffect(() => {
    if (projectScoped) void load()
  }, [projectScoped, load])

  useEffect(() => {
    const previous = previousTailNodeSeq.current
    previousTailNodeSeq.current = tailNodeSeq
    if (projectScoped && previous !== tailNodeSeq) void refresh()
  }, [projectScoped, refresh, tailNodeSeq])

  if (!projectScoped) return null

  if (detailState?.status !== 'ready') {
    const failed = detailState?.status === 'error'
    return (
      <button
        type="button"
        className={css.trigger}
        aria-label={t('conversation.aria')}
        title={failed ? t('conversation.updateFailed') : t('conversation.loading')}
        disabled={!failed}
        onClick={() => { void load() }}
      >
        {failed ? <IconWarningOutline16 size={14} /> : <IconLoadingOutline16 className={css.spin} size={14} />}
        <span className={css.triggerLabel}>{t('conversation.title')}</span>
      </button>
    )
  }

  const { access, conversation } = detailState.detail
  const creatorName = conversation?.creatorDisplayName ?? String(access.creatorUserId)
  const participants = conversation?.participants ?? []
  const entries: MenuEntry[] = [
    { type: 'label', id: 'visibility-label', text: t('conversation.title') },
    {
      id: 'visibility:project',
      label: (
        <span className={css.menuText}>
          <span className={css.menuTitle}>{t('visibility.project')}</span>
          <span className={css.menuDescription}>{t('visibility.project.description')}</span>
        </span>
      ),
      icon: <IconGlobeOutline14 size={16} />,
      disabled: !access.canManage || detailState.saving,
    },
    {
      id: 'visibility:private',
      label: (
        <span className={css.menuText}>
          <span className={css.menuTitle}>{t('visibility.private')}</span>
          <span className={css.menuDescription}>{t('visibility.private.description')}</span>
        </span>
      ),
      icon: <IconUserOutline16 size={16} />,
      disabled: !access.canManage || detailState.saving,
    },
  ]

  const errorText = detailState.error === 'visibility-locked'
    ? t('conversation.visibilityLocked')
    : detailState.error === 'update-failed'
      ? t('conversation.updateFailed')
      : !access.canManage ? t('conversation.manageDenied') : undefined
  if (errorText !== undefined) {
    entries.push({
      id: 'visibility-message',
      label: <span className={css.message}>{errorText}</span>,
      icon: <IconWarningOutline16 size={14} />,
      disabled: true,
    })
  }
  entries.push(
    { type: 'separator', id: 'participants-separator' },
    { type: 'label', id: 'creator-label', text: t('conversation.creator', { name: creatorName }) },
    { type: 'label', id: 'participants-label', text: t('conversation.participants', { count: participants.length }) },
    ...(participants.length === 0
      ? [{ id: 'participant:none', label: t('conversation.noParticipants'), disabled: true }]
      : participants.map(participant => ({
        id: `participant:${participant.userId}`,
        label: participantLabel(
          participant,
          count => t('conversation.contributions', { count }),
        ),
        icon: <IconUserOutline16 size={14} />,
        disabled: true,
      }))),
  )

  const triggerTitle = access.canManage ? t('conversation.aria') : t('conversation.manageDenied')
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={entries}
      selectedId={`visibility:${access.visibility}`}
      onSelect={(id) => {
        setOpen(false)
        void setVisibility(id.slice('visibility:'.length) as CollaborationVisibility)
      }}
      align="start"
      portal
      anchor={(
        <button
          type="button"
          className={css.trigger}
          aria-label={t('conversation.aria')}
          aria-haspopup="menu"
          aria-expanded={open}
          title={triggerTitle}
          onClick={() => {
            setOpen((value) => {
              if (!value) void refresh()
              return !value
            })
          }}
        >
          {access.visibility === 'project'
            ? <IconGlobeOutline14 size={14} />
            : <IconUserOutline16 size={14} />}
          <span className={css.triggerLabel}>
            {access.visibility === 'project' ? t('visibility.project') : t('visibility.private')}
          </span>
          {participants.length > 0 && <span className={css.count}>{participants.length}</span>}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      )}
    />
  )
}
