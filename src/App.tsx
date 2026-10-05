import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AddAppDialog,
  AndroidReportDialog,
  ApprovalDialog,
  BranchFootprint,
  AppFootprint,
  clean,
  ConfirmDialog,
  ErrorDialog,
  ExpoPanel,
  LocalFolderButton,
  PHASES,
  SettingsDialog,
  size,
  StorageDialog,
  type Confirmation
} from './dialogs'
import type { AppView, Approval, BranchView, FolderView, JobError, JobEvent } from './env'
import { Mark } from './Mark'
import { ShortcutButton } from './ShortcutButton'

interface StepProgress {
  step: string
  message: string
  percent?: number
  phase: number
  phaseSince: number
  startedAt: number
  estimate?: number[]
  line?: string
}
type Progress = Record<string, StepProgress>
type Ask = (confirmation: Confirmation) => void

/** A start that took longer than this is worth telling the tester about when it is done. */
const NOTIFY_AFTER_MS = 15_000

interface Notification {
  key: string
  appId: string
  title: string
  body: string
}

export default function App(): JSX.Element {
  const [apps, setApps] = useState<AppView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress>({})
  const [remote, setRemote] = useState<Record<string, string | null>>({})
  const [error, setError] = useState<JobError | null>(null)
  const [approval, setApproval] = useState<{ key: string; approval: Approval } | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [notification, setNotification] = useState<Notification | null>(null)
  /** Applications with a branch that became ready while the tester looked elsewhere. */
  const [unseen, setUnseen] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [storage, setStorage] = useState(false)
  const [settings, setSettings] = useState(false)
  const [storageTotal, setStorageTotal] = useState<number | null>(null)

  // Event handlers read the latest list and selection without being registered again.
  const appsRef = useRef(apps)
  appsRef.current = apps
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const reload = useCallback(async () => {
    const list = await window.trymydev.list()
    setApps(list)
    setSelected((current) => (current && list.some((a) => a.id === current) ? current : list[0]?.id ?? null))
  }, [])

  const measure = useCallback(() => {
    window.trymydev
      .usage()
      .then((entries) => setStorageTotal(entries.reduce((sum, e) => sum + e.bytes, 0)))
      .catch(() => undefined)
  }, [])

  const select = (appId: string): void => {
    setSelected(appId)
    setUnseen((current) => {
      if (!current.has(appId)) return current
      const next = new Set(current)
      next.delete(appId)
      return next
    })
  }

  useEffect(() => {
    void reload()
    void window.trymydev.refresh(undefined, true).then(setApps)
    // Measuring walks every folder: it waits until the window is drawn.
    const timer = setTimeout(measure, 1500)
    let remeasure: ReturnType<typeof setTimeout> | undefined

    const onStep = (e: JobEvent): void => {
      setProgress((p) => ({
        ...p,
        [e.key]: {
          step: e.step,
          message: e.message,
          percent: e.percent,
          phase: e.phase,
          phaseSince: e.phaseSince,
          startedAt: e.startedAt,
          estimate: e.estimate,
          line: e.step === p[e.key]?.step ? p[e.key]?.line : undefined
        }
      }))
      // A branch starting again makes its last "is running" out of date.
      if (e.step !== 'running') {
        setNotification((current) => (current?.key === e.key ? null : current))
        return
      }
      if (Date.now() - e.startedAt < NOTIFY_AFTER_MS) return
      const app = appsRef.current.find((a) => a.branches.some((b) => b.key === e.key))
      const branch = app?.branches.find((b) => b.key === e.key)
      if (!app || !branch) return
      const local = branch.kind === 'local'
      setNotification({
        key: e.key,
        appId: app.id,
        title: `${local && branch.ref === 'working tree' ? app.name : branch.ref} is running`,
        body: `${app.name} · ${local ? 'your local folder' : branch.name} — installed and started in ${clock(Date.now() - e.startedAt)}.`
      })
      if (app.id !== selectedRef.current) setUnseen((current) => new Set(current).add(app.id))
    }

    const offs = [
      window.trymydev.onStep(onStep),
      window.trymydev.onLog(({ key, line }) =>
        setProgress((p) => (p[key] ? { ...p, [key]: { ...p[key], line } } : p))
      ),
      window.trymydev.onError(setError),
      window.trymydev.onApproval(setApproval),
      window.trymydev.onUpdated(() => {
        void reload()
        // A start or a removal changes what is on disk; measured once things settle.
        clearTimeout(remeasure)
        remeasure = setTimeout(measure, 2000)
      }),
      window.trymydev.onRemote((e) => setRemote((r) => ({ ...r, [e.key]: e.remoteSha })))
    ]
    return () => {
      clearTimeout(timer)
      clearTimeout(remeasure)
      offs.forEach((off) => off())
    }
  }, [reload, measure])

  // A failure nothing caught — a removal, an approval — still reaches the tester, and the log.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent): void => {
      const message = clean(event.reason)
      setNotice(message)
      window.trymydev.reportError(message).catch(() => undefined)
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  const current = apps.find((a) => a.id === selected) ?? null
  const find = (key: string): { app?: AppView; branch?: BranchView } => {
    const app = apps.find((a) => a.branches.some((b) => b.key === key))
    return { app, branch: app?.branches.find((b) => b.key === key) }
  }

  return (
    <div className={`app platform-${window.trymydev.platform}`}>
      <div className="titlebar">
        <Mark size={22} />
        TryMyDev
      </div>
      <aside aria-label="Applications">
        <div className="aside-title">Applications</div>
        {apps.length === 0 && <p className="empty">No applications yet. Add one to start testing.</p>}
        <ul className="apps">
          {apps.map((a) => (
            <li key={a.id}>
              <button
                className={a.id === selected ? 'app-item selected' : 'app-item'}
                aria-current={a.id === selected ? 'page' : undefined}
                onClick={() => select(a.id)}
              >
                <span className="app-label">
                  <span className="app-name">{a.name}</span>
                  {a.repo && <span className="app-repo">{a.repo}</span>}
                </span>
                <AppSummary app={a} progress={progress} unseen={unseen.has(a.id)} />
              </button>
            </li>
          ))}
        </ul>
        <div className="aside-actions">
          <button className="primary" onClick={() => setAdding(true)}>
            + Add an application
          </button>
          <button className="nav" onClick={() => setStorage(true)}>
            Storage
            {storageTotal !== null && <span>{size(storageTotal)}</span>}
          </button>
          <button className="nav" onClick={() => setSettings(true)}>
            Settings
          </button>
        </div>
      </aside>

      <main>
        {current ? (
          <AppPanel
            app={current}
            progress={progress}
            remote={remote}
            onReload={reload}
            ask={setConfirmation}
          />
        ) : (
          <div className="welcome">
            <div className="welcome-mark">
              <Mark size={52} />
            </div>
            <h1>Test any branch of any project</h1>
            <p>
              Paste a link to a branch, a fork or a pull request. TryMyDev downloads it, builds it and starts it
              for you — nothing else to install.
            </p>
            <ol className="how">
              <li>
                <span className="number">1</span>
                <strong>Paste a link</strong>
                <span>A branch, fork, pull request — or a folder on this computer.</span>
              </li>
              <li>
                <span className="number">2</span>
                <strong>Review and run</strong>
                <span>You see every command before it runs. Then it builds itself.</span>
              </li>
              <li>
                <span className="number">3</span>
                <strong>Test and report</strong>
                <span>Found a bug? The tools button writes the report for you.</span>
              </li>
            </ol>
            <button className="primary" onClick={() => setAdding(true)}>
              Add your first application
            </button>
          </div>
        )}
      </main>

      <div className="corner">
        {notification && (
          <div className="notice" role="status" aria-live="polite">
            <div className="notice-from">
              <Mark size={16} />
              TryMyDev · now
            </div>
            <div className="notice-body">
              <span className="tick" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>{notification.title}</strong>
                <span>{notification.body}</span>
              </div>
            </div>
            <div className="notice-actions">
              <button className="ghost small" onClick={() => setNotification(null)}>
                Dismiss
              </button>
              <button
                className="primary small"
                onClick={() => {
                  select(notification.appId)
                  setNotification(null)
                }}
              >
                Show branch
              </button>
            </div>
          </div>
        )}
        {notice && (
          <div className="toast" role="alert">
            <b aria-hidden="true">!</b>
            <div className="toast-text">
              <strong>Something went wrong</strong>
              <span>{notice}</span>
              <div className="toast-actions">
                <button className="small" onClick={() => void window.trymydev.openAppLog()}>
                  View log
                </button>
                <button className="small" onClick={() => setNotice(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {adding && (
        <AddAppDialog
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            void reload()
            void window.trymydev.refresh(undefined, true).then(setApps)
          }}
        />
      )}
      {storage && (
        <StorageDialog
          onClose={() => {
            setStorage(false)
            measure()
          }}
        />
      )}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      {error && <ErrorDialog error={error} {...find(error.key)} onClose={() => setError(null)} />}
      {approval && (
        <ApprovalDialog
          approval={approval.approval}
          branchKey={approval.key}
          branch={find(approval.key).branch}
          onClose={() => setApproval(null)}
          onApproved={() => setApproval(null)}
        />
      )}
      {confirmation && (
        <ConfirmDialog
          confirmation={confirmation}
          onClose={() => {
            setConfirmation(null)
            measure()
          }}
        />
      )}
    </div>
  )
}

/** What the sidebar says of an application: its start in progress, a branch ready, or how many run. */
function AppSummary({ app, progress, unseen }: { app: AppView; progress: Progress; unseen: boolean }): JSX.Element {
  const now = useNow(app.branches.some((b) => b.busy && !b.running))
  const preparing = app.branches.find((b) => b.busy && !b.running)
  if (preparing) {
    const done = Math.round(overall(progress[preparing.key], now) * 100)
    return (
      <span className="app-sum prep" aria-label={`Preparing, ${done}%`}>
        <span
          className="ring"
          aria-hidden="true"
          style={{ background: `conic-gradient(var(--ok) ${done * 3.6}deg, var(--control) 0)` }}
        />
        {done}%
      </span>
    )
  }
  if (unseen) {
    return (
      <span className="app-sum ready" aria-label="New: a branch is ready">
        ✓ Ready
      </span>
    )
  }
  const running = app.branches.filter((b) => b.running).length
  if (running > 0) return <span className="app-sum live">● {running} running</span>
  return <span className="app-sum">{app.branches.length}</span>
}

function AppPanel({
  app,
  progress,
  remote,
  onReload,
  ask
}: {
  app: AppView
  progress: Progress
  remote: Record<string, string | null>
  onReload: () => Promise<void>
  ask: Ask
}): JSX.Element {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    setInput('')
    setAddError(null)
  }, [app.id])

  const addBranch = async (value = input): Promise<void> => {
    if (value.trim() === '') return
    setBusy(true)
    setAddError(null)
    try {
      await window.trymydev.addBranch(app.id, value)
      setInput('')
      await onReload()
    } catch (err) {
      setAddError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  const count = app.branches.length
  const running = app.branches.filter((b) => b.running).map((b) => b.ref)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{app.name}</h1>
          <div className="sub">
            {app.repo && (
              <>
                <span className="mono">{app.repo}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>{count === 0 ? 'No branches yet' : count === 1 ? '1 branch' : `${count} branches`}</span>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="ghost"
            disabled={checking}
            onClick={() => {
              setChecking(true)
              void window.trymydev.refresh(app.id).finally(() => setChecking(false))
            }}
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          <button
            className="danger"
            onClick={() =>
              ask({
                title: `Remove ${app.name}?`,
                action: `Remove ${app.name}`,
                details: (
                  <AppFootprint
                    app={app}
                    note={
                      (running.length > 0
                        ? `The running branch${running.length > 1 ? 'es' : ''} (${running.join(', ')}) ${running.length > 1 ? 'are' : 'is'} stopped first. `
                        : '') + `Your own ${app.name} installation, if you have one, is not touched.`
                    }
                  />
                ),
                run: async () => {
                  await window.trymydev.removeApp(app.id)
                  await onReload()
                }
              })
            }
          >
            Remove application
          </button>
        </div>
      </header>

      <FoldersCard app={app} />

      <section className="box add" aria-labelledby="add-label">
        <label id="add-label" htmlFor="add-input">
          Add a branch to test
        </label>
        <span id="add-help" className="help">
          A link to a branch, fork or pull request on GitHub — or a Git folder on this computer.
        </span>
        <div className="field-row">
          <input
            id="add-input"
            value={input}
            spellCheck={false}
            aria-describedby="add-help"
            aria-invalid={addError ? 'true' : 'false'}
            placeholder="https://github.com/owner/project/tree/branch"
            onChange={(e) => {
              setInput(e.target.value)
              setAddError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addBranch()
            }}
          />
          <LocalFolderButton onPicked={setInput} />
          <button className="primary" disabled={busy} onClick={() => void addBranch()}>
            {busy ? 'Adding…' : 'Add branch'}
          </button>
        </div>
        {addError && (
          <div className="alert add-error" role="alert">
            <b aria-hidden="true">!</b>
            <span>{addError}</span>
          </div>
        )}
      </section>

      <section className="list" aria-label="Branches">
        {count > 0 ? (
          <h2>Branches · {count}</h2>
        ) : (
          <div className="no-branch">
            <strong>No branch yet</strong>
            <span>
              Paste a branch link above.
              {app.repo && (
                <>
                  {' '}
                  The default branch is a good first test:{' '}
                  <button className="link" onClick={() => void addBranch(`https://github.com/${app.repo}`)}>
                    add {app.repo}
                  </button>
                </>
              )}
            </span>
          </div>
        )}
        {app.branches.map((branch) => (
          <BranchCard
            key={branch.key}
            app={app}
            branch={branch}
            progress={progress[branch.key]}
            remoteSha={remote[branch.key]}
            onReload={onReload}
            ask={ask}
          />
        ))}
      </section>
    </div>
  )
}

const FOLDERS_OPEN = 'trymydev.folders.open'

/** A remembered view choice; storage may be unavailable, and then nothing is remembered. */
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* not remembered */
  }
}

/** The application's folders the tester may point elsewhere, such as Modly's extensions. */
function FoldersCard({ app }: { app: AppView }): JSX.Element | null {
  const [folders, setFolders] = useState<FolderView[]>([])
  const [error, setError] = useState<string | null>(null)
  // Folded by default, one line; the choice is remembered for every application.
  const [open, setOpen] = useState(() => readPreference(FOLDERS_OPEN) === '1')

  useEffect(() => {
    let live = true
    setError(null)
    window.trymydev
      .folders(app.id)
      .then((list) => live && setFolders(list))
      .catch((err) => live && setError(clean(err)))
    return () => {
      live = false
    }
  }, [app.id, app.branches.length])

  if (folders.length === 0 && !error) return null

  const act = async (run: () => Promise<FolderView[]>): Promise<void> => {
    setError(null)
    try {
      setFolders(await run())
    } catch (err) {
      setError(clean(err))
    }
  }
  const origin: Record<FolderView['source'], string> = {
    installed: `From your own ${app.name} installation.`,
    own: "TryMyDev's own, shared by every branch.",
    custom: 'A folder you picked.'
  }
  const brief: Record<FolderView['source'], string> = {
    installed: `your ${app.name} install`,
    own: 'shared by TryMyDev',
    custom: 'your folder'
  }
  const toggle = (): void => {
    setOpen(!open)
    writePreference(FOLDERS_OPEN, open ? '0' : '1')
  }

  return (
    <section className={open ? 'box folders open' : 'box folders'} aria-label="Folders">
      <button type="button" className="folders-toggle" aria-expanded={open} onClick={toggle}>
        <span className="chevron" aria-hidden="true">
          ›
        </span>
        <span className="folders-title">Folders {app.name} uses</span>
        <span className="folders-summary">
          {folders.map((folder) => `${folder.label}: ${brief[folder.source]}`).join(' · ')}
        </span>
        <span className="folders-cta">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="folder-list">
          {folders.map((folder) => (
            <div key={folder.id} className="folder">
              <div className="folder-text">
                <span className="folder-label">{folder.label}</span>
                <span className="folder-path" title={folder.path}>
                  {folder.path}
                </span>
                <span className="folder-source">
                  {origin[folder.source]} Changes apply the next time a branch starts.
                </span>
              </div>
              <div className="folder-actions">
                {folder.installed && folder.source !== 'installed' && (
                  <button
                    className="ghost"
                    title={folder.installed}
                    onClick={() => void act(() => window.trymydev.useFolder(app.id, folder.id, 'installed'))}
                  >
                    Use {app.name}'s
                  </button>
                )}
                {folder.source !== 'own' && (
                  <button className="ghost" onClick={() => void act(() => window.trymydev.useFolder(app.id, folder.id, 'own'))}>
                    Use TryMyDev's
                  </button>
                )}
                <button className="ghost" onClick={() => void act(() => window.trymydev.chooseFolder(app.id, folder.id))}>
                  Choose folder…
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="folder-list">
          <div className="alert" role="alert">
            <b aria-hidden="true">!</b>
            <span>{error}</span>
          </div>
        </div>
      )}
    </section>
  )
}

function BranchCard({
  app,
  branch,
  progress,
  remoteSha,
  onReload,
  ask
}: {
  app: AppView
  branch: BranchView
  progress?: StepProgress
  remoteSha?: string | null
  onReload: () => Promise<void>
  ask: Ask
}): JSX.Element {
  const status = useMemo(() => statusOf(branch, remoteSha), [branch, remoteSha])
  const preparing = branch.busy && !branch.running
  const locked = branch.busy || branch.running
  const now = useNow(preparing)
  const sha = branch.builtSha?.slice(0, 7)
  const [reporting, setReporting] = useState(false)
  const expo = branch.running && branch.url?.startsWith('exp://') ? branch.url : undefined

  return (
    <article className={branch.running ? 'card live' : 'card'} aria-label={`${branch.name} ${branch.ref}, ${status.label}`}>
      <div className="card-head">
        <div className="ident">
          <div className="ident-line">
            <span className="name" title={branch.name}>
              {branch.name}
            </span>
            <span className="ref">{branch.ref}</span>
          </div>
          <span className="meta">{metaOf(app, branch, status.tone, sha)}</span>
        </div>
        <span role="status" className={'badge ' + status.tone}>
          <span aria-hidden="true">{status.icon}</span>
          {status.label}
        </span>
      </div>

      {preparing && <Steps progress={progress} now={now} />}
      {!locked && progress && progress.step === 'done' && <div className="last">{progress.message}</div>}
      {expo && <ExpoPanel url={expo} />}

      <div className="actions">
        {branch.running ? (
          <button className="outline" onClick={() => void window.trymydev.cancel(branch.key)}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={branch.busy} onClick={() => void window.trymydev.start(branch.key)}>
            {status.action}
          </button>
        )}
        {preparing && (
          <button className="ghost" onClick={() => void window.trymydev.cancel(branch.key)}>
            Cancel
          </button>
        )}
        {branch.running && branch.url && !expo && (
          <button className="ghost" onClick={() => void window.trymydev.openExternal(branch.url!)}>
            Open in browser ↗
          </button>
        )}
        {branch.reportable && (
          <button className="ghost" onClick={() => setReporting(true)}>
            Report bug
          </button>
        )}
        <button className="ghost" onClick={() => void window.trymydev.openLogs(branch.appId, branch.key)}>
          View log
        </button>
        {window.trymydev.platform === 'win32' && <ShortcutButton branchKey={branch.key} />}
        <span className="actions-end">
          {locked && <small>{branch.running ? 'Stop it to delete' : 'Wait or cancel to delete'}</small>}
          <button
            className="danger"
            disabled={locked}
            aria-label={`Delete ${branch.name} ${branch.ref}`}
            onClick={() =>
              ask({
                title: `Delete ${branch.ref}?`,
                sub: `${branch.name} · ${branch.ref}`,
                action: 'Delete branch',
                details: <BranchFootprint branchKey={branch.key} />,
                run: async () => {
                  await window.trymydev.removeBranch(branch.key)
                  await onReload()
                }
              })
            }
          >
            Delete
          </button>
        </span>
      </div>
      {reporting && <AndroidReportDialog branch={branch} onClose={() => setReporting(false)} />}
    </article>
  )
}

/** Download, Install, Build, Start: where a start is, and how long is left by the last one's measure. */
function Steps({ progress, now }: { progress?: StepProgress; now: number }): JSX.Element {
  const phase = progress?.phase ?? 0
  const fraction = progress ? phaseFraction(progress, now) : 0
  const left = progress ? remaining(progress, now) : undefined

  return (
    <div className="progress" aria-live="polite">
      <ol
        className="steps"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(overall(progress, now) * 100)}
        aria-label={`Step ${phase + 1} of ${PHASES.length}`}
      >
        {PHASES.map((label, i) => {
          const done = i < phase
          const current = i === phase
          return (
            <li key={label} className={done ? 'step done' : current ? 'step current' : 'step'} aria-current={current ? 'step' : undefined}>
              <span
                className="step-ring"
                aria-hidden="true"
                style={current ? { background: `conic-gradient(var(--ok) ${fraction * 360}deg, var(--control) 0)` } : undefined}
              >
                <span>{done ? '✓' : i + 1}</span>
              </span>
              {label}
            </li>
          )
        })}
        {left !== undefined && (
          <li className="eta">{left < 60_000 ? 'Less than a minute left' : `About ${Math.round(left / 60_000)} min left`}</li>
        )}
      </ol>
      <div className="progress-foot">
        <span className="tail" title={progress?.message}>
          {progress?.line ?? progress?.message ?? 'Starting…'}
        </span>
        {progress && (
          <span className="elapsed">
            {clock(now - progress.startedAt)} elapsed
            {progress.estimate ? ' · estimate from the last time' : ''}
          </span>
        )}
      </div>
    </div>
  )
}

/** How far the current phase is: its own percentage, else the time spent against last time's. */
function phaseFraction(p: StepProgress, now: number): number {
  if (p.percent !== undefined) return Math.min(p.percent / 100, 1)
  const expected = p.estimate?.[p.phase]
  return expected ? Math.min((now - p.phaseSince) / expected, 0.95) : 0
}

function overall(p: StepProgress | undefined, now: number): number {
  return p ? (p.phase + phaseFraction(p, now)) / PHASES.length : 0
}

function remaining(p: StepProgress, now: number): number | undefined {
  if (!p.estimate) return undefined
  let left = Math.max(0, (p.estimate[p.phase] ?? 0) - (now - p.phaseSince))
  for (let i = p.phase + 1; i < PHASES.length; i++) left += p.estimate[i] ?? 0
  return left
}

/** The time now, ticking every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function metaOf(app: AppView, branch: BranchView, tone: string, sha?: string): string {
  if (branch.running && branch.device) return `Running on ${branch.device}`
  if (branch.kind === 'local') {
    return branch.ref === 'working tree'
      ? 'Folder on this computer · runs as it is, uncommitted changes included'
      : `Folder on this computer · last commit of ${branch.ref}`
  }
  const upstreamOwner = app.repo?.split('/')[0]?.toLowerCase()
  if (branch.pr) {
    return branch.owner && branch.owner.toLowerCase() !== upstreamOwner
      ? `Pull request #${branch.pr} · from ${branch.owner}'s fork`
      : `Pull request #${branch.pr}`
  }
  if (tone === 'update') return `Built from commit ${sha} · a newer commit is on GitHub`
  if (branch.running && branch.url?.startsWith('exp://')) return `Commit ${sha ?? '—'} · in Expo Go`
  if (branch.running && branch.url) return `Commit ${sha ?? '—'} · open at ${branch.url.replace(/^https?:\/\//, '')}`
  if (sha) return `Commit ${sha}`
  return 'Not built yet'
}

function statusOf(
  branch: BranchView,
  remoteSha?: string | null
): { label: string; tone: string; icon: string; action: string } {
  if (branch.running) return { label: 'Running', tone: 'live', icon: '●', action: 'Run' }
  if (branch.busy) return { label: 'Preparing', tone: 'work', icon: '◔', action: 'Run' }
  if (!branch.builtSha) return { label: 'Not installed yet', tone: 'new', icon: '○', action: 'Install and run' }
  if (remoteSha && remoteSha !== branch.builtSha) {
    return { label: 'Update available', tone: 'update', icon: '↑', action: 'Update and run' }
  }
  // Not checked yet — without a GitHub token, only on asking: Run updates it anyway.
  return { label: 'Ready', tone: 'ok', icon: '✓', action: 'Run' }
}
