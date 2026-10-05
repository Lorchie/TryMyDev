import { execFile, spawn, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { arch, release, version } from 'os'
import { dirname, join, relative } from 'path'
import { promisify } from 'util'
import type { WindowInfo } from '../overlay/agent'
import { Journal, type JournalSnapshot } from '../overlay/journal'
import { redactText } from '../overlay/redact'
import { readLogTail, reportArchive, reportFileName, type ReportData, type ReportSource } from '../overlay/report'
import type { AppDriver } from './drive'
import { ANDROID_ID } from './manifest'
import { buildEnv, killTree, spawnTool, type RunContext, type Toolchain } from './proc'
import { AVD_NAME, ensureEmulator, ensurePlatformTools } from './runtimes/android'
import { ensureJava } from './runtimes/java'
import { ensureScrcpy } from './runtimes/scrcpy'
import { androidSdkDir } from './paths'
import type { BranchLog } from './logger'
import type { Manifest, StartSpec } from './types'

/**
 * An Android application on a device: a phone plugged in with USB debugging when there is one,
 * else TryMyDev's emulator. adb installs the APK and opens it, logcat brings the application's
 * lines into the branch log, scrcpy shows a phone's screen on the computer. Every adb command
 * gets its arguments as a list, and anything passed to the device's shell is quoted.
 */

type AndroidStart = Extract<StartSpec, { mode: 'android' }>

export interface AndroidDevice {
  serial: string
  /** `device` when usable; `unauthorized` until the phone accepts this computer. */
  state: string
  model?: string
  emulator: boolean
}

/** `adb devices -l`. */
export function parseDevices(text: string): AndroidDevice[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().match(/^(\S+)\s+(\S+)(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(([, serial, state, rest]) => ({
      serial,
      state,
      model: rest.match(/model:(\S+)/)?.[1]?.replace(/_/g, ' '),
      emulator: serial.startsWith('emulator-')
    }))
}

/** One argument of a command the device's shell reads: adb joins them with spaces. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ── adb ───────────────────────────────────────────────────────────────────────

export class Adb {
  constructor(
    readonly bin: string,
    private readonly ctx: RunContext,
    readonly serial?: string
  ) {}

  on(serial: string): Adb {
    return new Adb(this.bin, this.ctx, serial)
  }

  /** stdout, or an error carrying what adb said. */
  async run(args: string[], timeoutMs = 120_000): Promise<string> {
    return (await this.raw(args, timeoutMs)).toString('utf-8')
  }

  raw(args: string[], timeoutMs = 120_000): Promise<Buffer> {
    const full = this.serial ? ['-s', this.serial, ...args] : args
    return new Promise((resolve, reject) => {
      const child = spawnTool(this.bin, full, this.ctx, false)
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => {
        killTree(child)
        reject(new Error(`adb ${args.slice(0, 2).join(' ')} did not answer within ${timeoutMs / 1000} s.`))
      }, timeoutMs)
      child.stdout?.on('data', (d: Buffer) => out.push(d))
      child.stderr?.on('data', (d: Buffer) => err.push(d))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const stdout = Buffer.concat(out)
        if (code === 0) return resolve(stdout)
        const said = (Buffer.concat(err).toString('utf-8') || stdout.toString('utf-8')).trim()
        reject(new Error(`adb ${args.slice(0, 2).join(' ')} failed: ${said || `exit code ${code}`}`))
      })
    })
  }

  /** A command for the device's shell, each argument quoted. */
  shell(args: string[], timeoutMs?: number): Promise<string> {
    return this.run(['shell', args.map(shellQuote).join(' ')], timeoutMs)
  }

  spawn(args: string[]): ChildProcess {
    return spawnTool(this.bin, this.serial ? ['-s', this.serial, ...args] : args, this.ctx, false)
  }
}

// ── The device ────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)
const BOOT_MS = 5 * 60_000
const OFFLINE_MS = 90_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class NoDevice extends Error {}

/**
 * A phone first: it is what the application is made for, and it costs nothing to start. An
 * emulator already running next; else TryMyDev's own, started and left running for the next
 * start — it takes a minute to boot.
 */
export async function ensureDevice(
  adb: Adb,
  toolchain: Toolchain,
  log: BranchLog,
  say: (message: string) => void,
  signal?: AbortSignal
): Promise<{ device: AndroidDevice; adb: Adb }> {
  await adb.run(['start-server'])
  const devices = parseDevices(await adb.run(['devices', '-l']))
  for (const d of devices) log.line(`[device] ${d.serial} ${d.state}${d.model ? ` (${d.model})` : ''}`)

  const phone = devices.find((d) => !d.emulator && d.state === 'device')
  if (phone) return { device: phone, adb: adb.on(phone.serial) }
  const waiting = devices.find((d) => !d.emulator && d.state === 'unauthorized')
  if (waiting) {
    throw new NoDevice(
      `The phone ${waiting.serial} has not allowed this computer yet: unlock it and accept "Allow USB debugging", then start again.`
    )
  }
  const running = devices.find((d) => d.emulator && d.state === 'device')
  if (running) return { device: running, adb: adb.on(running.serial) }
  // One still starting — left by an earlier start — is waited for, not doubled. adb also keeps
  // "offline" ghosts of emulators that were killed: after a while, ours is started anyway.
  if (devices.some((d) => d.emulator && d.state === 'offline')) {
    say('Waiting for the Android emulator to finish starting…')
    const booted = await untilBooted(adb, signal, OFFLINE_MS).catch((err: unknown) => {
      if (!(err instanceof NoDevice)) throw err
      log.line('[device] the emulator adb lists as offline never came up: starting one')
      return undefined
    })
    if (booted) return booted
  }

  say('No phone plugged in — preparing the Android emulator…')
  const java = toolchain.java ?? (await ensureJava(undefined, log))
  const tools: Toolchain = { ...toolchain, java, androidSdk: androidSdkDir() }
  const emulator = await ensureEmulator(tools, log)
  await checkAcceleration(emulator, tools, log)

  say('Starting the Android emulator (a minute the first time)…')
  const ctx: RunContext = { toolchain: tools, cwd: androidSdkDir(), log }
  // Left running for the next start, outside TryMyDev's job object, its output kept out of pipes.
  // TRYMYDEV_EMULATOR_HEADLESS: the end-to-end tests run it without a window on the developer's screen.
  const headless = process.env.TRYMYDEV_EMULATOR_HEADLESS === '1' ? ['-no-window'] : []
  const child = spawn(emulator, ['-avd', AVD_NAME, '-no-boot-anim', '-no-snapshot-save', '-netdelay', 'none', '-netspeed', 'full', ...headless], {
    cwd: androidSdkDir(),
    env: buildEnv(ctx),
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()
  log.line(`[device] emulator ${AVD_NAME} started (pid ${child.pid})`)
  return untilBooted(adb, signal)
}

/** An emulator is usable once Android says it finished booting, not when adb first sees it. */
async function untilBooted(adb: Adb, signal?: AbortSignal, ms = BOOT_MS): Promise<{ device: AndroidDevice; adb: Adb }> {
  const until = Date.now() + ms
  for (;;) {
    signal?.throwIfAborted()
    const booted = parseDevices(await adb.run(['devices', '-l'])).find((d) => d.emulator && d.state === 'device')
    if (booted) {
      const on = adb.on(booted.serial)
      const done = await on.shell(['getprop', 'sys.boot_completed']).catch(() => '')
      if (done.trim() === '1') return { device: booted, adb: on }
    }
    if (Date.now() > until) throw new NoDevice('The Android emulator did not finish starting within 5 minutes.')
    await sleep(2000)
  }
}

/** Without a hypervisor the emulator does not start, or crawls: said before 2 GB are spent on it. */
async function checkAcceleration(emulator: string, toolchain: Toolchain, log: BranchLog): Promise<void> {
  const ctx: RunContext = { toolchain, cwd: androidSdkDir(), log }
  const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawnTool(emulator, ['-accel-check'], ctx, false)
    let text = ''
    child.stdout?.on('data', (d: Buffer) => (text += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (text += d.toString()))
    child.on('error', () => resolve({ code: -1, text }))
    child.on('close', (code) => resolve({ code, text }))
  })
  log.line(`[device] ${out.text.trim().split(/\r?\n/).join(' · ')}`)
  if (out.code === 0) return
  const fix =
    process.platform === 'win32'
      ? 'turn on "Windows Hypervisor Platform" in Windows Features (and virtualization in the firmware settings), then restart the computer'
      : process.platform === 'linux'
        ? 'allow KVM (the kvm group) and virtualization in the firmware settings'
        : 'use a Mac whose processor supports the Hypervisor framework'
  throw new NoDevice(`No phone is plugged in, and this computer cannot run the Android emulator: ${fix} — or plug in a phone with USB debugging on.`)
}

// ── The application ───────────────────────────────────────────────────────────

const SKIPPED = new Set(['node_modules', '.git', '.gradle', 'intermediates', 'tmp'])

/** The newest APK under a folder, test builds left out. */
function newestApk(dir: string, depth = 0): { path: string; time: number } | undefined {
  let best: { path: string; time: number } | undefined
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 8 || SKIPPED.has(entry.name) || /androidTest/i.test(entry.name)) continue
      const found = newestApk(path, depth + 1)
      if (found && (!best || found.time > best.time)) best = found
    } else if (entry.name.endsWith('.apk') && !/androidTest|-unaligned/i.test(entry.name)) {
      const time = statSync(path).mtimeMs
      if (!best || time > best.time) best = { path, time }
    }
  }
  return best
}

/** The APK a start installs: the file named, else the newest one under the folder or the checkout. */
export function findApk(checkout: string, apk?: string): string {
  const target = apk ? join(checkout, apk) : checkout
  if (apk && target.endsWith('.apk') && existsSync(target)) return target
  const found = newestApk(target)
  if (!found) {
    throw new Error(
      `No APK was found in ${apk ?? 'the project'} after the build. Its manifest can name it: "start": { "mode": "android", "apk": "app/build/outputs/apk/debug/app-debug.apk" }.`
    )
  }
  return found.path
}

const GRADLE_FILES = ['app/build.gradle.kts', 'app/build.gradle', 'android/app/build.gradle.kts', 'android/app/build.gradle']

/** The application id, from the manifest or from the Gradle build of its application module. */
export function packageOf(checkout: string, start: AndroidStart): string {
  if (start.package) return start.package
  const candidates = [...GRADLE_FILES]
  for (const dir of readdirSync(checkout, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    candidates.push(`${dir.name}/build.gradle.kts`, `${dir.name}/build.gradle`)
  }
  for (const file of candidates) {
    let text: string
    try {
      text = readFileSync(join(checkout, file), 'utf-8')
    } catch {
      continue
    }
    if (!/com\.android\.application|applicationId/.test(text)) continue
    const id = text.match(/applicationId\s*=?\s*["']([\w.]+)["']/)?.[1] ?? text.match(/namespace\s*=?\s*["']([\w.]+)["']/)?.[1]
    if (id && ANDROID_ID.test(id)) return id
  }
  throw new Error(
    'The application id could not be read from the Gradle build. Its manifest can give it: "start": { "mode": "android", "package": "com.example.app" }.'
  )
}

/**
 * The application id the APK itself declares — flavours and `applicationIdSuffix` included — read
 * with aapt2 from the build tools Gradle installed. Undefined without them: the Gradle build is read.
 */
export async function apkPackage(apk: string, log?: BranchLog, sdk = androidSdkDir()): Promise<string | undefined> {
  const dir = join(sdk, 'build-tools')
  let versions: string[]
  try {
    versions = readdirSync(dir)
  } catch {
    return undefined
  }
  const aapt2 = versions
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((version) => join(dir, version, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2'))
    .find((file) => existsSync(file))
  if (!aapt2) return undefined
  try {
    const { stdout } = await execFileAsync(aapt2, ['dump', 'packagename', apk], { timeout: 30_000, windowsHide: true })
    const id = stdout.trim()
    return ANDROID_ID.test(id) ? id : undefined
  } catch (err) {
    log?.line(`[launch] aapt2 could not read the APK: ${(err as Error).message.split(/\r?\n/)[0]}`)
    return undefined
  }
}

/** logcat from `since` (seconds on the device's clock), of one process when its PID is known. */
export function logcatArgs(since: string, pid?: number): string[] {
  return ['logcat', '-v', 'threadtime', ...(/^\d+$/.test(since) ? ['-T', `${since}.000`] : []), ...(pid ? [`--pid=${pid}`] : [])]
}

/** What adb install says, and what a tester can do about it. */
export function installFailure(output: string): string | undefined {
  if (/Success/.test(output)) return undefined
  const code = output.match(/INSTALL_[A-Z_]+/)?.[0]
  if (code === 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' || code === 'INSTALL_FAILED_VERSION_DOWNGRADE') {
    return (
      `${code}: this application is already installed on the device from another source — usually its published version, ` +
      'signed with another key. TryMyDev never uninstalls it, as that would delete its data: uninstall it on the device ' +
      'yourself to test this branch, or use the emulator.'
    )
  }
  if (code === 'INSTALL_FAILED_USER_RESTRICTED') {
    return `${code}: the phone refused the installation. Allow "Install via USB" in its developer options (some brands ask for it), then start again.`
  }
  if (code === 'INSTALL_FAILED_INSUFFICIENT_STORAGE') return `${code}: the device has no room left for the application.`
  return `The APK could not be installed: ${output.trim().split(/\r?\n/).pop() ?? 'no answer from adb'}`
}

export interface AndroidLaunch {
  adb: Adb
  device: AndroidDevice
  pkg: string
  pid?: number
  logcat: ChildProcess
  mirror?: ChildProcess
  journal: Journal
  problems: LogcatJournal
}

/**
 * Installs and opens the application, then follows it: its log lines into the branch log and the
 * journal, a phone's screen into a window of the computer.
 */
export async function launchAndroid(opts: {
  checkout: string
  apk: string
  manifest: Manifest
  start: AndroidStart
  toolchain: Toolchain
  log: BranchLog
  label: string
  say: (message: string) => void
  signal?: AbortSignal
}): Promise<AndroidLaunch> {
  const { log, say } = opts
  const adbBin = await ensurePlatformTools(log)
  const ctx: RunContext = { toolchain: { ...opts.toolchain, androidSdk: androidSdkDir() }, cwd: opts.checkout, log }
  const { device, adb } = await ensureDevice(new Adb(adbBin, ctx), ctx.toolchain, log, say, opts.signal)
  const pkg = opts.start.package ?? (await apkPackage(opts.apk, log)) ?? packageOf(opts.checkout, opts.start)
  log.line(`[launch] ${pkg} on ${device.model ?? device.serial}${device.emulator ? ' (emulator)' : ''}`)

  say(`Installing on ${device.model ?? device.serial}…`)
  log.line(`[launch] adb install ${relative(opts.checkout, opts.apk)}`)
  const output = await adb.run(['install', '-r', '-t', opts.apk], 5 * 60_000).catch((err: Error) => err.message)
  log.line(`[launch] ${output.trim()}`)
  const failure = installFailure(output)
  if (failure) throw new Error(failure)

  say(`Opening ${opts.manifest.name}…`)
  await adb.shell(['am', 'force-stop', pkg]).catch(() => undefined)
  // logcat keeps the device's history: only what comes after this is this run's.
  const since = (await adb.shell(['date', '+%s']).catch(() => '')).trim()
  await adb.shell(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']).catch((err: Error) => {
    if (!/No activities found/.test(err.message)) throw err
    throw new Error(
      `Android has no application ${pkg} to open. When the build gives it another id (a flavour, an applicationIdSuffix), ` +
        'the manifest can name it: "start": { "mode": "android", "package": "…" }.'
    )
  })
  const pid = await pidOf(adb, pkg, 15_000)
  log.line(pid ? `[launch] running, pid ${pid}` : '[launch] started, but its process was not seen yet')

  const journal = new Journal()
  const problems = new LogcatJournal(journal)
  const logcat = adb.spawn(logcatArgs(since, pid))
  let rest = ''
  logcat.stdout?.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString('utf-8')).split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      log.line(line)
      problems.line(line)
    }
  })

  let mirror: ChildProcess | undefined
  if (!device.emulator) {
    const scrcpy = await ensureScrcpy(log).catch((err: Error) => {
      log.line(`[launch] no screen mirroring: ${err.message}`)
      return undefined
    })
    if (scrcpy) {
      // scrcpy uses our adb, so a second adb server never fights the first.
      const mirrorCtx: RunContext = { ...ctx, cwd: dirname(scrcpy), extraEnv: { ADB: adbBin } }
      mirror = spawnTool(scrcpy, ['--serial', device.serial, '--window-title', opts.label, '--stay-awake', '--no-audio'], mirrorCtx)
      log.line(`[launch] screen of ${device.model ?? device.serial} mirrored`)
    }
  }
  return { adb, device, pkg, pid, logcat, mirror, journal, problems }
}

async function pidOf(adb: Adb, pkg: string, waitMs: number): Promise<number | undefined> {
  const until = Date.now() + waitMs
  for (;;) {
    const pid = Number((await adb.shell(['pidof', pkg]).catch(() => '')).trim().split(/\s+/)[0])
    if (pid > 0) return pid
    if (Date.now() > until) return undefined
    await sleep(500)
  }
}

/** Whether the application's process still runs: Android keeps no exit code for us. */
export async function stillRunning(launch: AndroidLaunch): Promise<boolean> {
  return (await pidOf(launch.adb, launch.pkg, 0)) !== undefined
}

export async function stopAndroid(launch: AndroidLaunch): Promise<void> {
  if (launch.mirror) killTree(launch.mirror)
  killTree(launch.logcat)
  await launch.adb.shell(['am', 'force-stop', launch.pkg]).catch(() => undefined)
}

/** `threadtime`: date time pid tid level tag: message. */
const LOGCAT = /^\d\d-\d\d\s+[\d:.]+\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]*?)\s*:\s?(.*)$/

/**
 * logcat into the journal. A message Android splits over lines — a crash and its stack, an error
 * and its cause — arrives as consecutive lines of one tag and level: they make one entry, its first
 * line said and the rest as detail. A crash is named by its exception, not by "FATAL EXCEPTION".
 */
export class LogcatJournal {
  private pending: { level: string; tag: string; lines: string[] } | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly journal: Journal) {}

  line(text: string): void {
    const m = LOGCAT.exec(text)
    if (!m) return
    const [, level, tag, message] = m
    if (level !== 'E' && level !== 'F' && level !== 'W') return this.flush()
    if (this.pending && this.pending.tag === tag && this.pending.level === level) {
      this.pending.lines.push(message)
    } else {
      this.flush()
      this.pending = { level, tag, lines: [message] }
    }
    // A message's lines come together: the next one arrives within milliseconds or not at all.
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 200)
    this.timer.unref?.()
  }

  flush(): void {
    clearTimeout(this.timer)
    const entry = this.pending
    this.pending = undefined
    if (!entry) return
    const [first, ...rest] = entry.lines
    if (entry.tag === 'AndroidRuntime' && /FATAL EXCEPTION/.test(first)) {
      const cause = rest.find((l) => /^[\w.$]+(Exception|Error)\b/.test(l)) ?? first
      this.journal.add('crash', `The application crashed: ${cause}`, entry.lines.join('\n'))
      return
    }
    const kind = entry.level === 'W' ? 'warning' : 'error'
    this.journal.add(kind, `${entry.tag}: ${first}`, rest.length ? entry.lines.join('\n') : undefined)
  }
}

// ── What an agent sees and does ───────────────────────────────────────────────

export interface UiNode {
  depth: number
  cls: string
  text: string
  desc: string
  id: string
  clickable: boolean
  editable: boolean
  checkable: boolean
  checked: boolean
  enabled: boolean
  focused: boolean
  selected: boolean
  password: boolean
  scrollable: boolean
  bounds: [number, number, number, number]
}

const attr = (tag: string, name: string): string =>
  (tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, ' ')
    .replace(/&amp;/g, '&')

/** The nodes of a `uiautomator dump`, in document order, with their depth. */
export function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = []
  let depth = 0
  for (const [tag] of xml.matchAll(/<\/node>|<node\b[^>]*?\/?>/g)) {
    if (tag === '</node>') {
      depth--
      continue
    }
    const b = attr(tag, 'bounds').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
    nodes.push({
      depth,
      cls: attr(tag, 'class').split('.').pop() ?? '',
      text: attr(tag, 'text'),
      desc: attr(tag, 'content-desc'),
      id: attr(tag, 'resource-id').split('/').pop() ?? '',
      clickable: attr(tag, 'clickable') === 'true' || attr(tag, 'long-clickable') === 'true',
      editable: /EditText|AutoCompleteTextView/.test(attr(tag, 'class')),
      checkable: attr(tag, 'checkable') === 'true',
      checked: attr(tag, 'checked') === 'true',
      enabled: attr(tag, 'enabled') !== 'false',
      focused: attr(tag, 'focused') === 'true',
      selected: attr(tag, 'selected') === 'true',
      password: attr(tag, 'password') === 'true',
      scrollable: attr(tag, 'scrollable') === 'true',
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0]
    })
    if (!tag.endsWith('/>')) depth++
  }
  return nodes
}

function roleOf(node: UiNode): string {
  if (node.editable) return 'textbox'
  if (/Switch/.test(node.cls)) return 'switch'
  if (node.checkable || /CheckBox/.test(node.cls)) return 'checkbox'
  if (/RadioButton/.test(node.cls)) return 'radio'
  if (/Button/.test(node.cls)) return 'button'
  if (/Image/.test(node.cls)) return node.clickable ? 'button' : 'image'
  if (node.scrollable) return 'list'
  if (node.clickable) return 'button'
  return 'text'
}

/** The screen as indented lines, as a web page's snapshot reads: `- button "OK" [ref=e3]`. */
export function renderUi(nodes: UiNode[]): { text: string; refs: Map<string, UiNode> } {
  const refs = new Map<string, UiNode>()
  const lines: string[] = []
  // A password field says that it is one, never what it holds.
  const nameOf = (node: UiNode): string =>
    (node.password ? '' : node.text) || node.desc || (node.clickable || node.editable ? node.id : '')
  const actsOn = (node: UiNode): boolean => node.clickable || node.editable || node.checkable || node.scrollable
  const shown = nodes.filter((node) => nameOf(node) || actsOn(node))
  // Layouts wrap an application in a dozen levels: the outermost shown starts at the margin.
  const base = Math.min(...shown.map((n) => n.depth))
  for (const node of shown) {
    const name = nameOf(node)
    const acts = actsOn(node)
    const role = roleOf(node)
    let line = `${'  '.repeat(Math.max(0, Math.min(node.depth - base, 12)))}- ${role}${name ? ` ${JSON.stringify(name.slice(0, 200))}` : ''}`
    if (node.password) line += ' [password]'
    if (node.checked) line += ' [checked]'
    if (node.focused) line += ' [focused]'
    if (node.selected) line += ' [selected]'
    if (!node.enabled) line += ' [disabled]'
    if (acts) {
      const ref = `e${refs.size + 1}`
      refs.set(ref, node)
      line += ` [ref=${ref}]`
    }
    lines.push(line)
  }
  return { text: lines.join('\n') || '(nothing on screen can be read: take a screenshot)', refs }
}

/** Android's key codes for the keys an agent names as on a web page. */
const KEYCODES: Record<string, number> = {
  enter: 66,
  escape: 4,
  back: 4,
  tab: 61,
  backspace: 67,
  delete: 112,
  space: 62,
  arrowup: 19,
  arrowdown: 20,
  arrowleft: 21,
  arrowright: 22,
  home: 3,
  end: 123,
  pageup: 92,
  pagedown: 93,
  menu: 82
}

/**
 * The `input text` commands that type a value. Android reads %s as a space and has no escape —
 * a backslash is typed as it is: a literal "%s" is cut in two commands. ASCII only.
 */
export function inputText(value: string): string[] {
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error('Only plain ASCII text can be typed on Android through adb: type the rest on the device.')
  }
  return value
    .split(/(?<=%)(?=s)/)
    .filter(Boolean)
    .map((part) => part.replace(/ /g, '%s'))
}

export class AndroidDriver implements AppDriver {
  private refs = new Map<string, UiNode>()

  constructor(
    private readonly launch: AndroidLaunch,
    private readonly label: string,
    private readonly report_: ReportSource | undefined
  ) {}

  close(): void {
    /* the device stays; stopAndroid ends the session */
  }

  private get adb(): Adb {
    return this.launch.adb
  }

  async windows(): Promise<WindowInfo[]> {
    return [{ id: 1, title: `${this.label} — ${this.launch.device.model ?? this.launch.device.serial}`, focused: true }]
  }

  async snapshot(): Promise<{ window: number; title: string; text: string }> {
    const file = '/data/local/tmp/trymydev-ui.xml'
    await this.adb.shell(['uiautomator', 'dump', file], 30_000)
    const xml = await this.adb.run(['exec-out', 'cat', file])
    const { text, refs } = renderUi(parseUiDump(xml))
    this.refs = refs
    return { window: 1, title: (await this.windows())[0].title, text }
  }

  private node(ref: string): UiNode {
    const node = this.refs.get(ref)
    if (!node) throw new Error(`No element ${ref} in the last snapshot: take a snapshot first.`)
    return node
  }

  private centre(node: UiNode): [string, string] {
    const [x1, y1, x2, y2] = node.bounds
    return [String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2))]
  }

  private act(text: string): void {
    this.launch.journal.add('action', text)
  }

  async click(ref: string, _window?: number, clicks = 1): Promise<number> {
    const node = this.node(ref)
    for (let i = 0; i < clicks; i++) await this.adb.shell(['input', 'tap', ...this.centre(node)])
    this.act(`Tapped ${roleOf(node)} ${JSON.stringify((node.password ? '' : node.text) || node.desc || node.id)}`)
    await sleep(500)
    return 1
  }

  async type(ref: string, value: string, submit: boolean): Promise<number> {
    const node = this.node(ref)
    const typed = inputText(value)
    await this.click(ref)
    // What the field holds goes first, as selecting all and typing over it would.
    await this.adb.shell(['input', 'keyevent', '123'])
    const held = node.password ? 64 : node.text.length
    if (held > 0) await this.adb.shell(['input', 'keyevent', ...Array<string>(held).fill('67')])
    for (const part of typed) await this.adb.shell(['input', 'text', part])
    if (submit) await this.adb.shell(['input', 'keyevent', '66'])
    this.act(`Typed into ${node.password ? 'a password field' : JSON.stringify(node.desc || node.id || 'a field')}`)
    await sleep(500)
    return 1
  }

  async press(combo: string): Promise<number> {
    const code = KEYCODES[combo.toLowerCase()]
    if (code !== undefined) await this.adb.shell(['input', 'keyevent', String(code)])
    else if (combo.length === 1) await this.adb.shell(['input', 'text', inputText(combo)[0]])
    else throw new Error(`Unknown key "${combo}" on Android: use a single character, or one of ${Object.keys(KEYCODES).join(', ')}.`)
    this.act(`Pressed ${combo}`)
    await sleep(500)
    return 1
  }

  async scroll(direction: 'up' | 'down', ref: string | undefined): Promise<number> {
    let x: number
    let top: number
    let bottom: number
    if (ref) {
      const [x1, y1, x2, y2] = this.node(ref).bounds
      x = Math.round((x1 + x2) / 2)
      top = y1 + (y2 - y1) * 0.2
      bottom = y1 + (y2 - y1) * 0.8
    } else {
      const size = (await this.adb.shell(['wm', 'size'])).match(/(\d+)x(\d+)\s*$/m)
      const [w, h] = size ? [Number(size[1]), Number(size[2])] : [1080, 2400]
      x = Math.round(w / 2)
      top = h * 0.25
      bottom = h * 0.75
    }
    // A finger moving up shows what is below.
    const [from, to] = direction === 'down' ? [bottom, top] : [top, bottom]
    await this.adb.shell(['input', 'swipe', String(x), String(Math.round(from)), String(x), String(Math.round(to)), '300'])
    this.act(`Scrolled ${direction}`)
    await sleep(600)
    return 1
  }

  async screenshot(): Promise<{ window: number; png: string }> {
    return { window: 1, png: (await this.png()).toString('base64') }
  }

  private png(): Promise<Buffer> {
    return this.adb.raw(['exec-out', 'screencap', '-p'], 30_000)
  }

  async journal(): Promise<JournalSnapshot> {
    return this.launch.journal.snapshot()
  }

  async report(description: string, screenshot: boolean): Promise<string> {
    const log = this.report_?.log
    if (!log) throw new Error('This application has no log folder to write a report into.')
    const data = await this.reportData()
    const text = redactText(description.slice(0, 10_000), this.launch.journal.context)
    const path = join(dirname(log), 'reports', reportFileName(this.label, data.at))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, reportArchive(data, text, screenshot ? await this.png().catch(() => undefined) : undefined))
    return path
  }

  /** The report's content, for the window's own report form too. */
  async reportData(): Promise<ReportData> {
    const props = async (name: string): Promise<string> => (await this.adb.shell(['getprop', name]).catch(() => '')).trim()
    const device = this.launch.device
    const environment = [
      `Device: ${[await props('ro.product.manufacturer'), device.model].filter(Boolean).join(' ')}${device.emulator ? ' (emulator)' : ''}`,
      `Android: ${await props('ro.build.version.release')} (API ${await props('ro.build.version.sdk')})`,
      `Application: ${this.launch.pkg}`,
      `Computer: ${version()} ${release()} (${arch()})`
    ]
    return {
      label: this.label,
      source: this.report_,
      at: Date.now(),
      environment,
      journal: this.launch.journal.snapshot(),
      log: this.report_?.log ? await readLogTail(this.report_.log, this.launch.journal.context) : []
    }
  }

  /** The screen as a PNG, for the report form. */
  capture(): Promise<Buffer> {
    return this.png()
  }

  async waitFor(text: string | undefined, seconds: number): Promise<boolean> {
    const until = Date.now() + seconds * 1000
    if (!text) {
      await sleep(seconds * 1000)
      return true
    }
    const wanted = text.toLowerCase()
    for (;;) {
      if ((await this.snapshot()).text.toLowerCase().includes(wanted)) return true
      if (Date.now() > until) return false
      await sleep(1000)
    }
  }
}

