import {
  AlertCircle,
  Inbox,
  LoaderCircle,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'

export function PageHeader({
  title,
  description,
  meta,
  actions,
}: {
  title: string
  description?: string
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="pageHeader">
      <div className="pageHeading">
        <div className="pageTitleLine">
          <h1>{title}</h1>
          {meta === undefined ? null : <span className="pageMeta">{meta}</span>}
        </div>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions === undefined ? null : <div className="pageActions">{actions}</div>}
    </header>
  )
}

export function Section({
  title,
  meta,
  actions,
  children,
  className = '',
}: {
  title?: string
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`section ${className}`.trim()}>
      {title === undefined && actions === undefined ? null : (
        <div className="sectionHeader">
          <div className="sectionTitleLine">
            {title === undefined ? null : <h2>{title}</h2>}
            {meta === undefined ? null : <span className="sectionMeta">{meta}</span>}
          </div>
          {actions === undefined ? null : <div className="sectionActions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  loading = false,
  icon: Icon,
  className = '',
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  loading?: boolean
  icon?: LucideIcon
}) {
  return (
    <button
      {...props}
      className={`button button-${variant} ${className}`.trim()}
      disabled={disabled === true || loading}
    >
      {loading ? <LoaderCircle className="spin" aria-hidden="true" /> : Icon === undefined ? null : <Icon aria-hidden="true" />}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  icon: Icon,
  variant = 'ghost',
  loading = false,
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> & {
  label: string
  icon: LucideIcon
  variant?: ButtonVariant
  loading?: boolean
}) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`iconButton iconButton-${variant} ${className}`.trim()}
      aria-label={label}
      title={label}
      disabled={props.disabled === true || loading}
    >
      {loading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}
    </button>
  )
}

type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function StatusBadge({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`statusBadge status-${tone}`}><span className="statusDot" />{children}</span>
}

export function ErrorBanner({ message }: { message: string }) {
  if (message === '') return null
  return (
    <div className="errorBanner" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}

export function LoadingState({ label = '正在加载' }: { label?: string }) {
  return <div className="loadingState" role="status"><LoaderCircle className="spin" aria-hidden="true" />{label}</div>
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  detail,
  action,
}: {
  icon?: LucideIcon
  title: string
  detail?: string
  action?: ReactNode
}) {
  return (
    <div className="emptyState">
      <span className="emptyIcon"><Icon aria-hidden="true" /></span>
      <strong>{title}</strong>
      {detail === undefined ? null : <p>{detail}</p>}
      {action === undefined ? null : <div>{action}</div>}
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`field ${className}`.trim()}>
      <span className="fieldLabel">{label}</span>
      {children}
      {hint === undefined ? null : <span className="fieldHint">{hint}</span>}
    </label>
  )
}

export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="switchControl">
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} />
      <span className="switchTrack" aria-hidden="true"><span /></span>
      <span>{label}</span>
    </label>
  )
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  danger = false,
}: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  danger?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="dialogSurface">
        <header className="dialogHeader">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description === undefined ? null : <p id={descriptionId}>{description}</p>}
          </div>
          <IconButton label="关闭" icon={X} onClick={onClose} />
        </header>
        {children === undefined ? null : <div className="dialogBody">{children}</div>}
        {footer === undefined ? null : <footer className={`dialogFooter ${danger ? 'dialogFooterDanger' : ''}`}>{footer}</footer>}
      </div>
    </dialog>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  pending?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      danger
      footer={(
        <>
          <Button type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="button" variant="danger" loading={pending} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    />
  )
}
