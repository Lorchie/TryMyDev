import type { BrowserWindow } from 'electron'
import { uptime } from 'os'
import { appLog } from './applog'
import { hintFor, tidyTail } from './hints'
import { BranchLog } from './logger'
import { processImage, processStartTime } from './proc'
import { ApprovalRequired, checkRemote, patchState, provision, readState } from './provision'
import * as registry from './registry'
import { adopt, isRunning, launch, stop, untilStopped } from './runner'
import { hasGithubToken } from './settings'
import { PHASES, type Approval, type Branch, type BranchState, type JobError, type JobEvent, type JobStep } from './types'

const jobs = new Map<string, AbortController>()
/** Jobs still preparing — installing from the download caches — rather than running. */
const preparing = new Set<string>()
/** The approval each branch waits for: what the tester was shown, kept with what they approve. */
const pending = new Map<string, Approval>()

/** The phase of `PHASES` each step belongs to; `running` and `done` stay in the one before. */
const PHASE_OF: Partial<Record<JobStep, number>> = {
  resolve: 0,
  download: 0,
  manifest: 0,
  runtime: 1,
  install: 1,
  build: 2,
  launch: 3
}

/** The phase a failure happened in: an application that exits failed at its start. */
export const phaseOf = (step: JobStep): number => PHASE_OF[step] ?? PHASES.length - 1

export function pendingApproval(key: string): Approval | undefined {
  return pending.get(key)
}

export function busy(key: string): boolean {
  return jobs.has(key)
}

export function installing(): boolean {
  return preparing.size > 0
}

export function cancel(key: string): void {
  jobs.get(key)?.abort(new Error('Cancelled by the user'))
  stop(key)
}

/** How a start ended, for a caller that is not the window — an agent. */
export type StartOutcome =
  | { status: 'running'; url?: string }
  | { status: 'busy' }
  | { status: 'approval' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; logTail: string }

/**
 * Update if needed, then run. Nothing here throws at the caller: a failure
 * reaches the tester as a pop-up carrying the tail of the log, and an
 * unapproved manifest reaches them as the list of commands it wants to run.
 */
export async function startBranch(win: BrowserWindow, key: string): Promise<StartOutcome> {
  await untilStopped(key)
  if (isRunning(key)) return { status: 'running', url: readState(registry.getBranch(key).appId, key).url }
  if (jobs.has(key)) return { status: 'busy' }

  const branch = registry.getBranch(key)
  const app = registry.getApp(branch.appId)
  const controller = new AbortController()
  jobs.set(key, controller)
  pending.delete(key)
  // The window shows the branch as preparing from now, not only once the job is over.
  send(win, 'branch:updated', { key })

  const log = new BranchLog(app.id, key)
  log.line(`=== ${app.name} · ${registry.label(branch)} ===`)
  log.onLine((line) => send(win, 'job:log', { key, line }))

  const startedAt = Date.now()
  const estimate = readState(app.id, key).durations
  const durations = PHASES.map(() => 0)
  /** Only a start that fetched or built something says how long the next one may take. */
  let worked = false
  let step: JobStep = 'resolve'
  let since = startedAt
  let phase = 0
  let phaseSince = startedAt
  const emit = (s: JobStep, message: string, percent?: number): void => {
    const now = Date.now()
    if (s !== step) since = now
    step = s
    if (s === 'download' || s === 'install' || s === 'build') worked = true
    const next = PHASE_OF[s]
    if (next !== undefined && next !== phase) {
      durations[phase] += now - phaseSince
      phase = next
      phaseSince = now
    }
    send<JobEvent>(win, 'job:step', { key, step: s, message, percent, since, phase, phaseSince, startedAt, estimate })
  }

  try {
    preparing.add(key)
    const { manifest, state, toolchain } = await provision(app, branch, log, emit, controller.signal).finally(
      () => preparing.delete(key)
    )

    emit('launch', `Starting ${manifest.name}…`)
    const { url, detached, device } = await launch(app, branch, manifest, state, toolchain, log, controller.signal, (code, reason) => {
      jobs.delete(key)
      patchState(app.id, key, { running: undefined })
      send(win, 'branch:updated', { key })
      if (code === 0 || code === null) {
        emit('done', `${manifest.name} closed`)
        return
      }
      // The application writes into the log file itself, so the tail is read there.
      void log.fileTail(30).then((logTail) =>
        fail(win, {
          key,
          step: 'running',
          message: reason ? `${manifest.name} ${reason.replace(/^The application /, '')}.` : `${manifest.name} exited with code ${code}.`,
          logTail,
          logPath: log.path
        })
      )
    }, (message) => emit('launch', message))

    durations[phase] += Date.now() - phaseSince
    patchState(app.id, key, {
      url,
      device,
      lastLaunch: new Date().toISOString(),
      running: detached,
      ...(worked ? { durations } : {})
    })
    emit('running', url ? `Running on ${url}` : device ? `${manifest.name} is open on ${device}` : `${manifest.name} is open`)
    send(win, 'branch:updated', { key })
    return { status: 'running', url }
  } catch (err) {
    jobs.delete(key)

    if (err instanceof ApprovalRequired) {
      log.line('[approval] waiting for the user to review the manifest')
      pending.set(key, err.approval)
      emit('done', 'Waiting for your approval')
      send(win, 'job:approval', { key, approval: err.approval })
      send(win, 'branch:updated', { key })
      return { status: 'approval' }
    }

    const message = err instanceof Error ? err.message : String(err)
    log.line(`[error] ${message}`)
    // A cancellation kills the running command, which then reports a failure of
    // its own — the tester asked for it, so it is not worth a pop-up.
    const logTail = log.getTail(30)
    if (controller.signal.aborted) emit('done', 'Cancelled')
    else fail(win, { key, step, message, logTail, logPath: log.path })
    send(win, 'branch:updated', { key })
    return controller.signal.aborted ? { status: 'cancelled' } : { status: 'failed', message, logTail: tidyTail(logTail) }
  }
}

/** How far the start time the system reports may be from the one recorded at launch. */
const START_TOLERANCE_MS = 60_000

/**
 * Whether a recorded application is still the process holding its PID. After a reboot, or
 * once it has exited, the same PID can belong to one of the tester's own programs — often
 * a node.exe or python.exe — which Stop would otherwise kill with its whole tree.
 */
async function stillOurs(running: NonNullable<BranchState['running']>, lastLaunch?: string): Promise<boolean> {
  const image = await processImage(running.pid)
  // ps may shorten the name; tasklist gives it whole.
  if (image === undefined || !running.image.startsWith(image)) return false

  const startedAt = running.startedAt ?? (lastLaunch ? Date.parse(lastLaunch) : NaN)
  if (Number.isNaN(startedAt)) return true
  if (startedAt < Date.now() - uptime() * 1000) return false
  const actual = await processStartTime(running.pid)
  return actual === undefined || Math.abs(actual - startedAt) <= START_TOLERANCE_MS
}

/**
 * After a restart, applications left running show as running again — and can be
 * stopped. A PID now held by another program is told apart by its executable and the
 * time it started.
 */
export async function reattach(getWindow: () => BrowserWindow | null): Promise<void> {
  for (const branch of registry.branches()) {
    const { running, lastLaunch } = readState(branch.appId, branch.key)
    if (!running || isRunning(branch.key)) continue

    if (!(await stillOurs(running, lastLaunch))) {
      patchState(branch.appId, branch.key, { running: undefined })
      continue
    }
    adopt(branch.key, running.pid, () => {
      patchState(branch.appId, branch.key, { running: undefined })
      const win = getWindow()
      if (win) send(win, 'branch:updated', { key: branch.key })
    })
  }
}

/** Branches checked without the tester asking: local clones always, GitHub ones with a token only. */
export function checkedFreely(list: Branch[]): Branch[] {
  return hasGithubToken() ? list : list.filter((branch) => branch.kind === 'local')
}

/** One conditional request per GitHub branch: free with a token, counted without one. A clone is read locally. */
export async function refresh(win: BrowserWindow, list: Branch[]): Promise<void> {
  for (const branch of list) {
    const remoteSha = await checkRemote(branch)
    send(win, 'branch:remote', {
      key: branch.key,
      remoteSha,
      builtSha: readState(branch.appId, branch.key).builtSha ?? null
    })
  }
}

function fail(win: BrowserWindow, error: JobError): void {
  appLog(`[job] ${error.key} failed at ${error.step}: ${error.message.split('\n')[0]}`)
  send<JobError>(win, 'job:error', {
    ...error,
    phase: phaseOf(error.step),
    logTail: tidyTail(error.logTail),
    hint: hintFor(`${error.message}\n${error.logTail}`)
  })
}

function send<T>(win: BrowserWindow, channel: string, payload: T): void {
  if (!win.isDestroyed()) win.webContents.send(channel, payload)
}
