import { useEffect, useState } from 'react'
import type { AppView, Approval, BranchView, JobError, Settings, Theme, UsageEntry } from './env'

/** What the tester sees of a start, in order; the main process numbers its events the same way. */
export const PHASES = ['Download', 'Install', 'Build', 'Start'] as const

const SYSTEM_NAME: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const systemName = (): string => SYSTEM_NAME[window.trymydev.platform] ?? 'system'

export function Modal({
  title,
  sub,
  tone,
  width,
  onClose,
  children,
  actions
}: {
  title: string
  sub?: string
  tone?: 'error'
  width?: 'narrow' | 'wide'
  onClose: () => void
  children: React.ReactNode
  actions: React.ReactNode
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={['dialog', tone, width].filter(Boolean).join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {sub && <span className="dialog-sub">{sub}</span>}
          </div>
          <button className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>
  )
}

/**
 * The bug report of an application running on Android, written from this window: the overlay
 * cannot reach a phone. Its screen, the application's errors and the log, masked, as the
 * overlay's report has them; the tester describes, reads the preview, and saves.
 */
export function AndroidReportDialog({ branch, onClose }: { branch: BranchView; onClose: () => void }): JSX.Element {
  const [prepared, setPrepared] = useState<{ markdown: string; logs: string; screenshot?: string } | null>(null)
  const [description, setDescription] = useState('')
  const [preview, setPreview] = useState('')
  const [screenshot, setScreenshot] = useState(true)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.trymydev
      .reportStart(branch.key)
      .then((report) => {
        setPrepared(report)
        setPreview(report.markdown)
      })
      .catch((err) => setError(clean(err)))
    return () => void window.trymydev.reportClose(branch.key)
  }, [branch.key])

  useEffect(() => {
    if (!prepared) return
    const timer = setTimeout(() => void window.trymydev.reportPreview(branch.key, description).then(setPreview), 250)
    return () => clearTimeout(timer)
  }, [branch.key, description, prepared])

  const save = async (): Promise<void> => {
    setError(null)
    try {
      setSaved(await window.trymydev.reportSave(branch.key, description, screenshot))
    } catch (err) {
      setError(clean(err))
    }
  }

  return (
    <Modal
      title="Report a bug"
      sub={`${branch.name} · ${branch.ref}${branch.device ? ` · ${branch.device}` : ''}`}
      width="wide"
      onClose={onClose}
      actions={
        <>
          <button className="ghost" onClick={onClose}>
            {saved ? 'Close' : 'Cancel'}
          </button>
          {!saved && (
            <button className="primary" disabled={!prepared} onClick={() => void save()}>
              Save report…
            </button>
          )}
        </>
      }
    >
      {saved ? (
        <p className="message">Saved as {saved}. Send this file to the developer.</p>
      ) : (
        <>
          {!prepared && !error && <p className="message">Reading the device…</p>}
          <textarea
            value={description}
            autoFocus
            placeholder="What happened, and what did you expect? The steps to reproduce help most."
            onChange={(e) => setDescription(e.target.value)}
          />
          {prepared?.screenshot && (
            <label className="option">
              <input type="checkbox" checked={screenshot} onChange={(e) => setScreenshot(e.target.checked)} />
              <span>
                Include the screenshot — it is not masked
                <img className="report-shot" src={prepared.screenshot} alt="The device's screen" />
              </span>
            </label>
          )}
          {prepared && (
            <details>
              <summary>Preview — read it before sending</summary>
              <pre className="report-preview">{preview}</pre>
            </details>
          )}
        </>
      )}
      {error && (
        <div className="alert" role="alert">
          <b aria-hidden="true">!</b>
          <span>{error}</span>
        </div>
      )}
    </Modal>
  )
}

/** Expo Go opens the branch from this code: Android's Expo Go app, or an iPhone's camera. */
export function ExpoPanel({ url }: { url: string }): JSX.Element {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    void window.trymydev.qrImage(url).then(setImage, () => setImage(null))
  }, [url])
  return (
    <div className="expo">
      {image && <img src={image} width={160} height={160} alt={`QR code of ${url}`} />}
      <div className="expo-text">
        <b>Open it on your phone</b>
        <span>Install Expo Go (Play Store or App Store), then scan this code: with Expo Go on Android, with the Camera app on iPhone.</span>
        <span>The phone must be on the same Wi-Fi as this computer. If nothing loads, allow TryMyDev's Node.js through the firewall for private networks.</span>
        <code>{url}</code>
      </div>
    </div>
  )
}

export interface Confirmation {
  title: string
  sub?: string
  message?: string
  /** What goes, measured: a footprint the dialog loads itself. */
  details?: React.ReactNode
  action: string
  run: () => Promise<void>
}

/** Asked before anything is deleted: shared data can weigh tens of gigabytes. */
export function ConfirmDialog({
  confirmation,
  onClose
}: {
  confirmation: Confirmation
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      title={confirmation.title}
      sub={confirmation.sub}
      width="narrow"
      onClose={busy ? () => undefined : onClose}
      actions={
        <>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await confirmation.run()
              } finally {
                onClose()
              }
            }}
          >
            {busy ? 'Deleting…' : confirmation.action}
          </button>
        </>
      }
    >
      {confirmation.message && <p className="message">{confirmation.message}</p>}
      {confirmation.details}
    </Modal>
  )
}

/** Usage entries, once measured. */
function useUsage(): UsageEntry[] | null {
  const [entries, setEntries] = useState<UsageEntry[] | null>(null)
  useEffect(() => {
    void window.trymydev.usage().then(setEntries)
  }, [])
  return entries
}

const total = (entries: UsageEntry[]): number => entries.reduce((sum, e) => sum + e.bytes, 0)

/** What removing an application deletes, measured. */
export function AppFootprint({ app, note }: { app: AppView; note: string }): JSX.Element {
  const entries = useUsage()?.filter((e) => e.appId === app.id)
  const branches = entries?.filter((e) => e.key)
  const shared = entries?.filter((e) => !e.key)
  const count = app.branches.length

  return (
    <>
      <p className="message">This deletes from this computer:</p>
      <ul className="rows">
        <li>
          <span>
            {count === 0 ? 'Its settings' : count === 1 ? 'Its branch and its build' : `Its ${count} branches and their builds`}
          </span>
          <span className="size">{branches ? size(total(branches)) : 'Measuring…'}</span>
        </li>
        {(!shared || total(shared) > 0) && (
          <li>
            <span>Models and data shared between branches</span>
            <span className="size">{shared ? size(total(shared)) : 'Measuring…'}</span>
          </li>
        )}
      </ul>
      <p className="note">{note}</p>
    </>
  )
}

/** What deleting one branch frees, measured. */
export function BranchFootprint({ branchKey }: { branchKey: string }): JSX.Element {
  const entry = useUsage()?.find((e) => e.key === branchKey)
  return (
    <p className="message">
      Its sources, build and data are deleted from this computer
      {entry && <span className="note"> ({size(entry.bytes)})</span>}. You can add it again later — it will simply be
      rebuilt.
    </p>
  )
}

const MANIFEST_LABEL: Record<string, string> = {
  repository: 'Committed in the repository',
  provided: 'Given to you by the developer',
  builtin: 'Shipped with TryMyDev',
  detected: 'Guessed from the project'
}

/**
 * A manifest is arbitrary commands, and the person running them is often not the
 * person who wrote them. Everything that will run is shown in full, once per
 * manifest — and again whenever it changes.
 */
export function ApprovalDialog({
  approval,
  branchKey,
  branch,
  onClose,
  onApproved
}: {
  approval: Approval
  branchKey: string
  branch?: BranchView
  onClose: () => void
  onApproved: () => void
}): JSX.Element {
  const owner = approval.repo.split('/')[0]
  const changed = new Set(approval.changed ?? [])
  const lines = [...changed].map((i) => i + 1)
  const sourceNote = approval.local
    ? `a folder on this computer${approval.upstream ? `, cloned from ${approval.upstream}` : ''}`
    : approval.foreign
      ? `a fork, not the official ${approval.upstream}`
      : 'the official repository'
  const where = [approval.appName, branch?.name ?? approval.repo, branch?.kind === 'local' && branch.ref === 'working tree' ? undefined : branch?.ref]

  return (
    <Modal
      title="Review before running"
      sub={where.filter(Boolean).join(' · ')}
      width="wide"
      onClose={onClose}
      actions={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => {
              // The run itself takes minutes; its progress shows on the branch card.
              void window.trymydev.approve(approval.appId, approval.manifestHash, branchKey)
              onApproved()
            }}
          >
            Approve and run
          </button>
        </>
      }
    >
      <dl className="facts">
        <dt>Source</dt>
        <dd>
          <strong>{approval.repo}</strong> — {sourceNote}
        </dd>
        <dt>Manifest</dt>
        <dd>{MANIFEST_LABEL[approval.source ?? 'detected']}</dd>
        <dt>Runs as</dt>
        <dd>Your {systemName()} account — this code can read your files.</dd>
      </dl>
      {approval.local && (
        <div className="hint" role="note">
          <b aria-hidden="true">i</b>
          <span>
            Approvals for GitHub and for local folders are separate: approving this folder doesn't approve
            {approval.upstream ? ` ${approval.upstream}` : ' its repository'} on GitHub, and the other way round.
          </span>
        </div>
      )}
      {approval.foreign && (
        <div className="hint warn" role="note">
          <b aria-hidden="true">!</b>
          <span>
            This code comes from someone other than the official project. Only approve if you trust {owner}.
          </span>
        </div>
      )}
      {lines.length > 0 && (
        <div className="hint warn" role="note">
          <b aria-hidden="true">!</b>
          <span>
            {lines.length === 1 ? 'A command' : `${lines.length} commands`} changed since you last approved this code — see
            line{lines.length > 1 ? 's' : ''} {lines.join(', ')}.
          </span>
        </div>
      )}
      {(approval.install?.changes.length ?? 0) > 0 && (
        <div className="hint warn" role="note">
          <b aria-hidden="true">!</b>
          <span>
            This fork changes what runs at install compared with {approval.install?.against} — read it below before
            approving.
          </span>
        </div>
      )}
      {approval.warnings.map((warning) => (
        <div className="hint warn" role="note" key={warning}>
          <b aria-hidden="true">!</b>
          <span>{warning}</span>
        </div>
      ))}
      <div className="block">
        <h3>1 · Commands that will run</h3>
        <ol className="commands">
          {approval.commands.map((command, i) => (
            <li key={i} className={changed.has(i) ? 'changed' : undefined}>
              <span className="n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="text">{command}</span>
              {changed.has(i) && <span className="tag">Changed</span>}
            </li>
          ))}
        </ol>
      </div>
      {approval.install && (
        <div className="block">
          <h3>What this fork changes at install</h3>
          {approval.install.unavailable ? (
            <p className="note">
              Not compared with {approval.install.against}: {approval.install.unavailable}
            </p>
          ) : approval.install.changes.length === 0 ? (
            <p className="note">
              Same install files as {approval.install.against}: npm, pip and Gradle run what the official project runs.
            </p>
          ) : (
            approval.install.changes.map((change) => (
              <div className="install-change" key={change.file}>
                <code>{change.file}</code>
                {change.added && <span> — not in {approval.install?.against}</span>}
                <pre className="log">{change.lines.join('\n')}</pre>
              </div>
            ))
          )}
        </div>
      )}
      <div className={approval.settings.length > 0 ? 'columns' : undefined}>
        {approval.settings.length > 0 && (
          <div className="block">
            <h3>2 · Settings it changes</h3>
            <pre className="log">{approval.settings.join('\n')}</pre>
          </div>
        )}
        <div className="block">
          <h3>{approval.settings.length > 0 ? 3 : 2} · What it downloads</h3>
          <pre className="log">{approval.downloads.join('\n') || 'Nothing.'}</pre>
        </div>
      </div>
      <p className="note">
        {approval.local
          ? 'Approving trusts this folder: its future changes run without asking again, as long as these commands stay the same.'
          : `Approving trusts ${approval.repo}: its other branches and future commits run without asking again, as long as these commands stay the same.`}
      </p>
    </Modal>
  )
}

/** Lines of a log that say something failed, shown in red. */
const BAD_LINE = /\b(error|failed|fatal|exception|traceback)\b|ERR!/i

export function ErrorDialog({
  error,
  app,
  branch,
  onClose
}: {
  error: JobError
  app?: AppView
  branch?: BranchView
  onClose: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const phase = error.phase ?? PHASES.length - 1
  const report = [
    `Step: ${error.step}`,
    `Branch: ${error.key}`,
    '',
    error.message,
    ...(error.hint ? ['', `Hint: ${error.hint}`] : []),
    '',
    '--- log ---',
    error.logTail
  ].join('\n')
  const sub = [app?.name, branch?.name, branch?.ref].filter(Boolean).join(' · ')

  return (
    <Modal
      title={`${PHASES[phase]} failed`}
      sub={sub || undefined}
      tone="error"
      width="wide"
      onClose={onClose}
      actions={
        <>
          {error.logPath && (
            <button className="ghost aside-action" onClick={() => void window.trymydev.showItem(error.logPath)}>
              Open full log
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="primary"
            onClick={() => {
              window.trymydev.copy(report)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? '✓ Copied' : 'Copy report'}
          </button>
        </>
      }
    >
      <ol className="pills" aria-label="Steps">
        {PHASES.map((label, i) => (
          <li key={label} className={i < phase ? 'done' : i === phase ? 'failed' : undefined}>
            <span aria-hidden="true">{i < phase ? '✓' : i === phase ? '✕' : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="block">
        <h3>What happened</h3>
        <p className="message">{error.message}</p>
      </div>
      {error.hint && (
        <div className="hint">
          <b aria-hidden="true">→</b>
          <div>
            <strong>What you can do</strong>
            <span>{error.hint}</span>
          </div>
        </div>
      )}
      <details open>
        <summary>Last lines of the log</summary>
        <pre className="log">
          {error.logTail
            ? error.logTail.split('\n').map((line, i) => (
                <span key={i} className={BAD_LINE.test(line) ? 'bad' : undefined}>
                  {line}
                  {'\n'}
                </span>
              ))
            : 'No output.'}
        </pre>
      </details>
    </Modal>
  )
}

/** The system's folder dialog; the path then goes in the address field, where it can be given a branch. */
export function LocalFolderButton({ onPicked }: { onPicked: (path: string) => void }): JSX.Element {
  return (
    <button
      className="ghost"
      onClick={() =>
        void window.trymydev.pickRepository().then((path) => {
          if (path) onPicked(path)
        })
      }
    >
      Choose folder…
    </button>
  )
}

export function AddAppDialog({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded: () => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const [manifest, setManifest] = useState('')
  const [showManifest, setShowManifest] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.trymydev.addApp(url, manifest)
      onAdded()
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add an application"
      onClose={onClose}
      actions={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || url.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add application'}
          </button>
        </>
      }
    >
      <p className="message">
        TryMyDev downloads the project, installs what it needs and starts it. You'll review every command first.
      </p>
      <div className="block">
        <label className="label" htmlFor="app-url">
          Link or folder
        </label>
        <div className="field-row">
          <input
            id="app-url"
            autoFocus
            value={url}
            spellCheck={false}
            placeholder="https://github.com/owner/project/tree/branch"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url.trim() !== '') void submit()
            }}
          />
          <LocalFolderButton onPicked={setUrl} />
        </div>
      </div>
      <dl className="facts examples">
        <dt>A branch</dt>
        <dd className="mono">github.com/owner/project/tree/branch</dd>
        <dt>A pull request</dt>
        <dd className="mono">github.com/owner/project/pull/42</dd>
        <dt>A local folder</dt>
        <dd>Runs exactly as checked out, uncommitted changes included (minus .gitignore).</dd>
      </dl>
      <button className="toggle-link" aria-expanded={showManifest} onClick={() => setShowManifest(!showManifest)}>
        <span className="chevron" aria-hidden="true">
          ›
        </span>
        The developer gave me a manifest <span>(optional)</span>
      </button>
      {showManifest && (
        <div className="block">
          <label className="label" htmlFor="manifest">
            Manifest
          </label>
          <textarea
            id="manifest"
            value={manifest}
            spellCheck={false}
            rows={6}
            placeholder='{ "name": "…", "start": { "mode": "web", "run": "npm run dev" } }'
            onChange={(e) => setManifest(e.target.value)}
          />
          <span className="small-help">Without one, TryMyDev works it out from the project.</span>
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          <b aria-hidden="true">!</b>
          <span>{error}</span>
        </div>
      )}
    </Modal>
  )
}

/** The groups that are not an application, in the order they are listed after them. */
const FIXED_GROUPS = ['Tools', 'Environments', 'Download caches', 'Leftovers']
const GROUP_COLOR: Record<string, string> = {
  Tools: 'var(--violet)',
  Environments: 'var(--cyan)',
  'Download caches': 'var(--faint)',
  Leftovers: 'var(--warn)'
}
const APP_COLORS = ['var(--accent)', 'var(--ok)', '#e88fd0', '#f0a35e', '#8fd0e8']

export function StorageDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [entries, setEntries] = useState<UsageEntry[] | null>(null)
  const [freed, setFreed] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.trymydev.usage().then(setEntries)
  }, [])

  const used = total(entries ?? [])
  const unused = total((entries ?? []).filter((e) => e.orphan))
  const names = [...new Set((entries ?? []).map((e) => e.group))]
  const apps = names.filter((name) => !FIXED_GROUPS.includes(name))
  const groups = [...apps, ...FIXED_GROUPS.filter((name) => names.includes(name))].map((name) => {
    const rows = (entries ?? []).filter((e) => e.group === name)
    return { name, rows, bytes: total(rows), color: GROUP_COLOR[name] ?? APP_COLORS[apps.indexOf(name) % APP_COLORS.length] }
  })
  // An application's rows drop its name: the group heading already says it.
  const rowLabel = (entry: UsageEntry): string =>
    entry.label.startsWith(`${entry.group} · `) ? entry.label.slice(entry.group.length + 3) : entry.label

  return (
    <Modal
      title="Storage"
      onClose={onClose}
      actions={
        freed !== null && unused === 0 ? (
          <button className="primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="ghost" onClick={onClose}>
              Close
            </button>
            <button
              className="primary"
              disabled={busy || entries === null || unused === 0}
              onClick={async () => {
                setBusy(true)
                try {
                  setFreed(await window.trymydev.prune())
                  setEntries(await window.trymydev.usage())
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Removing…' : unused > 0 ? `Remove unused · ${size(unused)}` : 'Nothing unused'}
            </button>
          </>
        )
      }
    >
      {entries === null ? (
        <p className="message">Measuring…</p>
      ) : (
        <>
          <div className="total">
            <strong>{size(used)}</strong>
            <span>used by TryMyDev</span>
            {freed !== null && <span className="freed">✓ {size(freed)} freed</span>}
          </div>
          <div className="share" aria-hidden="true">
            {groups.map((group) => (
              <span key={group.name} style={{ width: `${used ? (group.bytes / used) * 100 : 0}%`, background: group.color }} />
            ))}
          </div>
          <div className="groups">
            {groups.map((group) => (
              <div key={group.name}>
                <div className="group-head">
                  <span className="swatch" aria-hidden="true" style={{ background: group.color }} />
                  {group.name}
                  <span className="size">{size(group.bytes)}</span>
                </div>
                <ul className="rows">
                  {group.rows.map((entry) => (
                    <li key={entry.path} className={entry.orphan ? 'orphan' : undefined}>
                      <span>{rowLabel(entry)}</span>
                      {entry.orphan && <span className="unused">Unused</span>}
                      <span className="size">{size(entry.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="note">
            “Remove unused” only deletes leftovers no branch needs. Your branches, models, extensions and workspace stay.
          </p>
        </>
      )}
    </Modal>
  )
}

const THEME_LABEL: Record<Theme, string> = { system: `Match ${systemName()}`, dark: 'Dark', light: 'Light' }

const pick = (settings: Settings): Pick<Settings, 'autoCleanup' | 'overlay' | 'agent' | 'agentError' | 'theme'> => ({
  autoCleanup: settings.autoCleanup,
  overlay: settings.overlay,
  agent: settings.agent,
  agentError: settings.agentError,
  theme: settings.theme
})

/** The GitHub token: checked with GitHub before it is kept, never shown again. */
export function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [saved, setSaved] = useState<boolean | null>(null)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [agentNote, setAgentNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [prefs, setPrefs] = useState<ReturnType<typeof pick> | null>(null)

  useEffect(() => {
    void window.trymydev.getSettings().then((settings) => {
      setSaved(settings.githubToken)
      setPrefs(pick(settings))
    })
  }, [])

  const toggle = async (name: 'autoCleanup' | 'overlay' | 'agent', value: boolean): Promise<void> => {
    setAgentNote(null)
    try {
      setPrefs(pick(await window.trymydev.setPreference(name, value)))
    } catch (err) {
      setStatus(clean(err))
    }
  }

  const apply = async (value: string | null): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.trymydev.setGithubToken(value)
      setSaved(result.githubToken)
      setToken('')
      setStatus(
        result.githubToken
          ? `Token saved — ${result.limit ?? '?'} GitHub requests an hour.`
          : 'Token removed — 60 GitHub requests an hour.'
      )
    } catch (err) {
      setStatus(clean(err))
    } finally {
      setBusy(false)
    }
  }

  const switches: { name: 'autoCleanup' | 'overlay' | 'agent'; section: string; label: string; desc: string }[] = [
    {
      name: 'autoCleanup',
      section: 'Storage',
      label: 'Clean up automatically at startup',
      desc: 'Removes environments no branch uses, leftovers from deleted branches, and download caches unused for two weeks. Never your branches, models, extensions, workspace or workflows.'
    },
    {
      name: 'overlay',
      section: 'Tested applications',
      label: 'Show the tools button in tested apps',
      desc: 'A small button in the corner of their window, with Report a bug. Turn it off if an app ever misbehaves with it. Applies the next time a branch starts.'
    },
    {
      name: 'agent',
      section: 'Agent access',
      label: 'Let an AI agent test the applications',
      desc: 'Claude Code or another MCP client on this computer can start branches, click and type in them, read errors and write bug reports. It can never approve commands. Needs the tools button, and applies to branches started from now on.'
    }
  ]

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      actions={
        <button className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <section className="inline">
        <h3 id="appearance">Appearance</h3>
        <div className="segmented" role="radiogroup" aria-labelledby="appearance">
          {(['system', 'dark', 'light'] as const).map((theme) => (
            <button
              key={theme}
              role="radio"
              aria-checked={prefs?.theme === theme}
              disabled={!prefs}
              onClick={() =>
                void window.trymydev
                  .setTheme(theme)
                  .then((settings) => setPrefs(pick(settings)))
                  .catch((err) => setStatus(clean(err)))
              }
            >
              {THEME_LABEL[theme]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>GitHub access</h3>
        <div className={saved ? 'status ok' : 'status'}>
          <b aria-hidden="true">{saved ? '✓' : '○'}</b>
          <span>
            {saved === null ? (
              'Checking…'
            ) : saved ? (
              <>
                <strong>Token saved</strong> · 5,000 requests an hour, private repositories
              </>
            ) : (
              <>
                <strong>No token</strong> · 60 requests an hour, public repositories only
              </>
            )}
          </span>
          {saved && (
            <button className="danger" disabled={busy} onClick={() => void apply(null)}>
              Remove token
            </button>
          )}
        </div>
        <label className="label" htmlFor="token">
          {saved ? 'Replace with a new token' : 'GitHub token'}
        </label>
        <div className="field-row">
          <input
            id="token"
            type="password"
            value={token}
            spellCheck={false}
            placeholder="github_pat_…"
            aria-describedby="token-help"
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="primary" disabled={busy || token.trim() === ''} onClick={() => void apply(token)}>
            {busy ? 'Checking…' : 'Save token'}
          </button>
        </div>
        <span id="token-help" className="small-help">
          Optional — needed for private repositories and more than 60 requests an hour. Use a fine-grained token with
          read-only access to contents, and nothing more. It's stored encrypted for your account, which the applications
          you approve run under too.
        </span>
        {status && (
          <p className="message" role="status">
            {status}
          </p>
        )}
      </section>

      {switches.map((item) => {
        const on = prefs?.[item.name] ?? item.name !== 'agent'
        return (
          <section key={item.name}>
            <h3>{item.section}</h3>
            <div className="switch-row">
              <div>
                <strong id={`switch-${item.name}`}>{item.label}</strong>
                <span>{item.desc}</span>
              </div>
              <button
                className="switch"
                role="switch"
                aria-checked={on}
                aria-labelledby={`switch-${item.name}`}
                disabled={!prefs}
                onClick={() => void toggle(item.name, !on)}
              />
            </div>
            {item.name === 'agent' && prefs?.agent && (
              <div className="panel">
                {prefs.agentError && <span>{prefs.agentError}</span>}
                <span>Connect Claude Code: copy the command, then run it once in a terminal.</span>
                <div className="row">
                  <button
                    className="ghost"
                    onClick={() =>
                      void window.trymydev
                        .copyAgentCommand()
                        .then(() => {
                          setCopied(true)
                          setTimeout(() => setCopied(false), 1500)
                          setAgentNote('Copied. Run it once in a terminal to add TryMyDev to Claude Code.')
                        })
                        .catch((err) => setAgentNote(clean(err)))
                    }
                  >
                    {copied ? '✓ Command copied' : 'Copy the Claude Code command'}
                  </button>
                  <button
                    className="ghost"
                    onClick={() =>
                      void window.trymydev
                        .renewAgentToken()
                        .then(() => setAgentNote('New token created — the old one no longer works. The new command is copied: run it again.'))
                        .catch((err) => setAgentNote(clean(err)))
                    }
                  >
                    Revoke and make a new token
                  </button>
                </div>
                {agentNote && (
                  <span className="done" role="status">
                    {agentNote}
                  </span>
                )}
              </div>
            )}
          </section>
        )
      })}
    </Modal>
  )
}

export function size(bytes: number): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes > 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} kB`
}

/** Electron prefixes IPC rejections with "Error invoking remote method …". */
export function clean(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
