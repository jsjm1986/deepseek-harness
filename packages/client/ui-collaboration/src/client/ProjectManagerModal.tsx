import { useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Modal, IconFolderOpenOutline16, IconPlusOutline16, IconShareOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectInvitation } from './collaboration-client.ts'
import type { CollaborationKey } from './locales.ts'
import css from './ProjectManagerModal.module.css'

/** Which project-management surface the modal is showing. */
export type ProjectManagerMode = 'create' | 'members'

/** Controlled project-management modal props. */
export interface ProjectManagerModalProps {
  open: boolean
  mode: ProjectManagerMode
  projectId?: number
  canManage?: boolean
  currentUserId: number
  t: (key: CollaborationKey, params?: Record<string, string | number>) => string
  createProject?: (name: string) => Promise<number>
  listInvitations?: (projectId?: number) => Promise<ProjectInvitation[]>
  inviteMember?: (projectId: number, username: string, mode: 'ro' | 'rw') => Promise<ProjectInvitation>
  acceptInvitation?: (id: string) => Promise<void>
  onCreated: (projectId: number) => void
  onClose: () => void
}

function errorText(error: unknown, t: ProjectManagerModalProps['t']): string {
  if (error instanceof Error && error.message !== '') {
    const known: Record<string, CollaborationKey> = {
      'invitation-already-pending': 'manager.invitationPending',
      'invitation-already-member': 'manager.alreadyMember',
      'user-not-found': 'manager.userNotFound',
      'user-disabled': 'manager.userDisabled',
      'invitation-forbidden': 'manager.invitationForbidden',
      forbidden: 'manager.invitationForbidden',
      'invitation-expired': 'manager.invitationExpired',
      'invitation-not-pending': 'manager.invitationNotPending',
      'invalid-invitation-id': 'manager.invalidInvitation',
      'cannot-invite-self': 'manager.cannotInviteSelf',
      'owner-protected': 'manager.ownerProtected',
      'owner-must-be-rw': 'manager.ownerMustRw',
      'project-not-found': 'manager.projectNotFound',
      'invitation-not-found': 'manager.invitationNotFound',
      'managed-projects-unavailable': 'manager.unavailable',
    }
    const key = known[error.message]
    if (key !== undefined) return t(key)
  }
  return t('manager.failed')
}

/** Render the user-owned project creation and member invitation dialog. */
export function ProjectManagerModal({
  open, mode, projectId, canManage = false, currentUserId, t,
  createProject, listInvitations, inviteMember, acceptInvitation, onCreated, onClose,
}: ProjectManagerModalProps) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [memberMode, setMemberMode] = useState<'ro' | 'rw'>('rw')
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([])
  const [loadingInvitations, setLoadingInvitations] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    setName('')
    setUsername('')
    setMemberMode('rw')
    setError(undefined)
    if (mode !== 'members' || listInvitations === undefined) {
      setInvitations([])
      return
    }
    let active = true
    setLoadingInvitations(true)
    void listInvitations(projectId)
      .then((next) => { if (active) setInvitations(next) })
      .catch((nextError: unknown) => { if (active) setError(errorText(nextError, t)) })
      .finally(() => { if (active) setLoadingInvitations(false) })
    return () => { active = false }
  }, [open, mode, projectId, listInvitations, t])

  const submitCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || createProject === undefined || name.trim() === '') return
    setBusy(true)
    setError(undefined)
    try {
      onCreated(await createProject(name.trim()))
    } catch (nextError) {
      setError(errorText(nextError, t))
    } finally {
      setBusy(false)
    }
  }

  const submitInvite = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy || projectId === undefined || inviteMember === undefined || username.trim() === '') return
    setBusy(true)
    setError(undefined)
    try {
      await inviteMember(projectId, username.trim(), memberMode)
      setUsername('')
      if (listInvitations !== undefined) setInvitations(await listInvitations(projectId))
    } catch (nextError) {
      setError(errorText(nextError, t))
    } finally {
      setBusy(false)
    }
  }

  const accept = async (id: string): Promise<void> => {
    if (busy || acceptInvitation === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await acceptInvitation(id)
      if (listInvitations !== undefined) setInvitations(await listInvitations(projectId))
    } catch (nextError) {
      setError(errorText(nextError, t))
    } finally {
      setBusy(false)
    }
  }

  const pending = invitations.filter(invitation => invitation.status === 'pending')
  const title = mode === 'create' ? t('manager.createTitle') : t('manager.membersTitle')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('manager.close')}
      description={mode === 'create' ? t('manager.createDescription') : t('manager.membersDescription')}
      footer={(
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t('manager.cancel')}
        </Button>
      )}
    >
      {mode === 'create' ? (
        <form className={css.form} onSubmit={(event) => { void submitCreate(event) }}>
          <label className={css.label} htmlFor="collaboration-project-name">{t('manager.nameLabel')}</label>
          <Input
            id="collaboration-project-name"
            value={name}
            onChange={(event) => { setName(event.target.value) }}
            placeholder={t('manager.namePlaceholder')}
            autoFocus
            maxLength={120}
            required
          />
          <div className={css.pathNote}>
            <IconFolderOpenOutline16 size={16} />
            <span>{t('manager.folderNote')}</span>
          </div>
          {error !== undefined && <div className={css.error} role="alert">{error}</div>}
          <Button variant="primary" type="submit" disabled={busy || name.trim() === ''} icon={<IconPlusOutline16 size={16} />}>
            {busy ? t('manager.creating') : t('manager.create')}
          </Button>
        </form>
      ) : (
        <div className={css.members}>
          {canManage && projectId !== undefined && (
            <form className={css.form} onSubmit={(event) => { void submitInvite(event) }}>
              <label className={css.label} htmlFor="collaboration-invite-username">{t('manager.usernameLabel')}</label>
              <Input
                id="collaboration-invite-username"
                value={username}
                onChange={(event) => { setUsername(event.target.value) }}
                placeholder={t('manager.usernamePlaceholder')}
                autoFocus
                required
              />
              <label className={css.label} htmlFor="collaboration-invite-mode">{t('manager.modeLabel')}</label>
              <select
                id="collaboration-invite-mode"
                className={css.select}
                value={memberMode}
                onChange={(event) => { setMemberMode(event.target.value === 'ro' ? 'ro' : 'rw') }}
              >
                <option value="rw">{t('manager.readWrite')}</option>
                <option value="ro">{t('manager.readOnly')}</option>
              </select>
              <Button variant="primary" type="submit" disabled={busy || username.trim() === ''} icon={<IconShareOutline16 size={16} />}>
                {busy ? t('manager.inviting') : t('manager.invite')}
              </Button>
            </form>
          )}
          <section className={css.invitationSection} aria-label={t('manager.invitationsLabel')}>
            <h3 className={css.sectionTitle}>{t('manager.invitationsLabel')}</h3>
            {loadingInvitations && <p className={css.muted}>{t('manager.loading')}</p>}
            {!loadingInvitations && pending.length === 0 && <p className={css.muted}>{t('manager.none')}</p>}
            {pending.map(invitation => (
              <div className={css.invitation} key={invitation.id}>
                <div className={css.invitationText}>
                  <strong>{invitation.projectName}</strong>
                  <span>{invitation.invitee.id === currentUserId
                    ? t('manager.invitedBy', { name: invitation.inviter.displayName })
                    : t('manager.invitedUser', { name: invitation.invitee.displayName })}</span>
                </div>
                {invitation.invitee.id === currentUserId && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { void accept(invitation.id) }}>
                    {t('manager.accept')}
                  </Button>
                )}
              </div>
            ))}
          </section>
          {error !== undefined && <div className={css.error} role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  )
}
