import { useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14, IconGlobeOutline14, IconShareOutline16,
  IconPlusOutline16, IconUserOutline16, IconWarningOutline16, Menu, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  CollaborationSnapshot, CollaborationVisibility,
} from './collaboration-client.ts'
import type { NS } from './locales.ts'
import { ProjectManagerModal, type ProjectManagerMode } from './ProjectManagerModal.tsx'
import css from './ScopeControl.module.css'

/** Registration-side collaboration state and actions for the sidebar footer. */
export interface ScopeControlInjected {
  hooks: {
    /** Shared Gateway collaboration snapshot, bound as useCollaboration. */
    collaboration: HostObservable<CollaborationSnapshot>
  }
  /** Persist a different runtime scope and reload the page. */
  switchScope: (scope: { kind: 'personal' } | { kind: 'project'; projectId: number }) => Promise<void>
  /** Stage visibility for the next project conversation. */
  stageVisibility: (visibility: CollaborationVisibility) => void
  /** User-owned project and invitation operations. */
  createProject?: (name: string) => Promise<number>
  listInvitations?: (projectId?: number) => Promise<import('./collaboration-client.ts').ProjectInvitation[]>
  inviteMember?: (projectId: number, username: string, mode: 'ro' | 'rw') => Promise<import('./collaboration-client.ts').ProjectInvitation>
  acceptInvitation?: (id: string) => Promise<void>
}

/** Full sidebar collaboration-control props. */
export type ScopeControlProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<ScopeControlInjected>
  & PropsLocale<typeof NS>

/**
 * Render the personal/project runtime selector and project create visibility.
 * @param props - composed slot props.
 * @returns scope trigger and its portaled menu, or null outside Gateway collaboration.
 */
export function ScopeControl({
  wide, useCollaboration, switchScope, stageVisibility,
  createProject, listInvitations, inviteMember, acceptInvitation, t,
}: ScopeControlProps) {
  const state = useCollaboration(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [managerMode, setManagerMode] = useState<ProjectManagerMode>()
  const context = state.context
  if (state.status !== 'ready' || context === undefined
    || (context.scope.kind === 'personal' && context.projects.length === 0
      && createProject === undefined && listInvitations === undefined)) return null

  const projectScope = context.scope.kind === 'project' ? context.scope : undefined
  const currentLabel = projectScope?.projectName ?? t('scope.personal')
  const currentScopeId = projectScope === undefined
    ? 'scope:personal'
    : `scope:project:${projectScope.projectId}`
  const entries: MenuEntry[] = [
    { type: 'label', id: 'personal-label', text: t('scope.personal') },
    {
      id: 'scope:personal',
      label: t('scope.personal'),
      icon: <IconUserOutline16 size={16} />,
      disabled: state.scopeBusy,
    },
    { type: 'separator', id: 'scope-separator' },
    { type: 'label', id: 'project-label', text: t('scope.projects') },
    ...context.projects.map(project => ({
      id: `scope:project:${project.projectId}`,
      label: (
        <span className={css.menuText}>
          <span className={css.menuTitle}>{project.name}</span>
          <span className={css.menuDescription}>
            {project.mode === 'ro' ? t('scope.readOnly') : t('scope.readWrite')}
          </span>
        </span>
      ),
      icon: <IconShareOutline16 size={16} />,
      disabled: state.scopeBusy,
    })),
  ]

  const currentProject = projectScope === undefined
    ? undefined
    : context.projects.find(project => project.projectId === projectScope.projectId)
  const managerEntries: MenuEntry[] = []
  if (createProject !== undefined) {
    managerEntries.push({
      id: 'project:create',
      label: t('manager.createAction'),
      icon: <IconPlusOutline16 size={16} />,
    })
  }
  if (listInvitations !== undefined) {
    managerEntries.push({
      id: 'project:members',
      label: currentProject?.canManage === true ? t('manager.membersAction') : t('manager.invitationsAction'),
      icon: <IconShareOutline16 size={16} />,
    })
  }

  if (projectScope?.mode === 'rw') {
    entries.push(
      { type: 'separator', id: 'visibility-separator' },
      { type: 'label', id: 'visibility-label', text: t('newConversation.label') },
      {
        id: 'visibility:project',
        label: (
          <span className={css.menuText}>
            <span className={css.menuTitle}>{t('visibility.project')}</span>
            <span className={css.menuDescription}>{t('visibility.project.description')}</span>
          </span>
        ),
        icon: <IconGlobeOutline14 size={16} />,
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
      },
    )
  }

  const scopeTitle = state.scopeError === undefined
    ? state.scopeBusy ? t('scope.switching') : t('scope.aria')
    : t('scope.failed')
  const iconSize = wide ? 16 : 18

  return (
    <>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={entries}
        {...managerEntries.length > 0 ? { footer: managerEntries } : {}}
        selectedIds={[
          currentScopeId,
          ...(projectScope?.mode === 'rw' ? [`visibility:${state.stagedVisibility}`] : []),
        ]}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'scope:personal') {
            void switchScope({ kind: 'personal' })
            return
          }
          if (id.startsWith('scope:project:')) {
            void switchScope({ kind: 'project', projectId: Number(id.slice('scope:project:'.length)) })
            return
          }
          if (id === 'project:create') {
            setManagerMode('create')
            return
          }
          if (id === 'project:members') {
            setManagerMode('members')
            return
          }
          stageVisibility(id.slice('visibility:'.length) as CollaborationVisibility)
        }}
        side="top"
        align="start"
        portal
        anchor={(
          <button
            type="button"
            className={css.trigger}
            aria-label={t('scope.aria')}
            aria-haspopup="menu"
            aria-expanded={open}
            title={scopeTitle}
            disabled={state.scopeBusy}
            onClick={() => { setOpen(value => !value) }}
          >
            {state.scopeError === undefined
              ? projectScope === undefined
                ? <IconUserOutline16 size={iconSize} />
                : <IconShareOutline16 size={iconSize} />
              : <IconWarningOutline16 size={iconSize} />}
            {wide && (
              <>
                <span className={css.label}>{currentLabel}</span>
                {projectScope !== undefined && (
                  <span className={css.mode}>
                    {projectScope.mode === 'ro' ? t('scope.readOnly') : t('scope.readWrite')}
                  </span>
                )}
                <IconChevronDownOutline14 className={css.chevron} />
              </>
            )}
          </button>
        )}
      />
      <ProjectManagerModal
        open={managerMode !== undefined}
        mode={managerMode ?? 'create'}
        currentUserId={context.user.id}
        t={t}
        {...projectScope === undefined ? {} : { projectId: projectScope.projectId }}
        {...currentProject?.canManage === true ? { canManage: true } : {}}
        {...createProject === undefined ? {} : { createProject }}
        {...listInvitations === undefined ? {} : { listInvitations }}
        {...inviteMember === undefined ? {} : { inviteMember }}
        {...acceptInvitation === undefined ? {} : { acceptInvitation }}
        onCreated={(projectId) => {
          setManagerMode(undefined)
          void switchScope({ kind: 'project', projectId })
        }}
        onClose={() => { setManagerMode(undefined) }}
      />
    </>
  )
}
