import { existsSync, readFileSync } from 'fs'
import { lstat, mkdir, unlink, writeFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import * as tar from 'tar'
import {
  hashString,
  linkDir,
  moveDir,
  readJson,
  removePath,
  removeTree,
  renameRetrying,
  sha256File,
  writeJson
} from './fsx'
import { withLock } from './lock'
import { findApk } from './android'
import { downloadArtifact, findArtifact } from './github'
import { reviewInstall } from './install-changes'
import { approvalOf, manifestHash, resolveManifest, startFor, stepsFor, wants } from './manifest'
import { systemProxy } from './network'
import {
  appShared,
  branchDir,
  cacheDir,
  checkoutDir,
  nodeCacheDir,
  nodeModulesStore,
  rootDir,
  statePath,
  tmpDir,
  venvStore
} from './paths'
import type { LocalHead } from './local-git'
import { fetchArchive, headOf, peekHead, type Known } from './sources'
import { ensureFreeSpace } from './storage'
import { run, type Toolchain } from './proc'
import * as registry from './registry'
import { expectedElectronMajor, needsOwnElectron, resolveElectronBinary } from './runner'
import { cachedNode, ensureNode } from './runtimes/node'
import { cachedUv, ensurePython, ensureUv } from './runtimes/python'
import { cachedAndroidSdk, ensureAndroidSdk, platformOf } from './runtimes/android'
import { extract } from './runtimes/download'
import { cachedFlutter, ensureFlutter } from './runtimes/flutter'
import { cachedGit, ensureGit } from './runtimes/git'
import { cachedJava, ensureJava } from './runtimes/java'
import { githubToken } from './settings'
import { ensureShims } from './runtimes/shim'
import type { BranchLog } from './logger'
import type { App, Approval, Branch, BranchState, GithubSource, JobStep, Manifest, Step } from './types'

export type Emit = (step: JobStep, message: string, percent?: number) => void

/** Raised when a manifest has never been shown to the user, or has changed. */
export class ApprovalRequired extends Error {
  constructor(readonly approval: Approval) {
    super(`${approval.appName} needs your approval before it runs.`)
  }
}

export interface Provisioned {
  checkout: string
  manifest: Manifest
  state: BranchState
  toolchain: Toolchain
}

export function readState(appId: string, key: string): BranchState {
  return readJson<BranchState>(statePath(appId, key), {})
}

export function patchState(appId: string, key: string, patch: Partial<BranchState>): BranchState {
  const state = { ...readState(appId, key), ...patch }
  writeJson(statePath(appId, key), state)
  return state
}

/**
 * Head commit, or null when it cannot be read. On GitHub, conditional: free with a token only;
 * a local clone is free.
 */
export async function checkRemote(branch: Branch): Promise<string | null> {
  try {
    const sha = await peekHead(branch, known(readState(branch.appId, branch.key)))
    patchState(branch.appId, branch.key, { lastCheck: new Date().toISOString() })
    return sha
  } catch {
    return null
  }
}

/** The sources last read, and what the local folder looked like then. */
function known(state: BranchState): Known | undefined {
  return state.sha ? { sha: state.sha, fingerprint: state.fingerprint } : undefined
}

export async function provision(
  app: App,
  branch: Branch,
  log: BranchLog,
  emit: Emit,
  signal: AbortSignal
): Promise<Provisioned> {
  const checkout = checkoutDir(app.id, branch.key)
  const state = readState(app.id, branch.key)

  emit('resolve', branch.kind === 'local' ? 'Reading the local folder…' : 'Reading the latest commit from GitHub…')
  let head: LocalHead
  try {
    head = await headOf(branch, (line) => log.line(line), known(state))
  } catch (err) {
    // GitHub out of reach is no reason not to start; a local folder's refusal — too many
    // untracked files — is, and must be read.
    if (!state.builtSha || branch.kind === 'local') throw err
    log.line(`[resolve] ${(err as Error).message} — starting the cached build`)
    head = { sha: state.builtSha }
  }
  const sha = head.sha
  for (const warning of head.warnings ?? []) log.line(`[resolve] warning: ${warning}`)
  // The same sources, a folder touched without changing them: its new look stands for them too.
  if (head.fingerprint && head.fingerprint !== state.fingerprint && sha === state.sha) {
    patchState(app.id, branch.key, { fingerprint: head.fingerprint })
  }

  // ── Fast path: nothing moved, nothing to do ────────────────────────────────
  if (state.builtSha === sha && existsSync(checkout)) {
    const manifest = resolveManifest(checkout, app, branch)
    // An APK GitHub Actions built needs nothing of what would have built it.
    const prebuilt = state.apk !== undefined && existsSync(join(branchDir(app.id, branch.key), state.apk))
    const toolchain = prebuilt ? await bareToolchain(manifest) : await cachedToolchain(manifest, state)
    if (toolchain && manifestHash(manifest) === state.manifestHash) {
      log.line(`[cache] ${sha.slice(0, 7)} already built — nothing to do`)
      emit('done', `Already up to date (${sha.slice(0, 7)}) — starting now`)
      return { checkout, manifest, state, toolchain }
    }
  }

  // Sources already extracted for this commit — waiting for an approval, or after a
  // failed build — are used as they are.
  if (state.sha !== sha || !existsSync(checkout)) {
    await fetchSources(app, branch, sha, log, emit, signal)
  }
  patchState(app.id, branch.key, { sha, fingerprint: head.fingerprint, builtSha: undefined })

  emit('manifest', 'Reading the project manifest…')
  const manifest = resolveManifest(checkout, app, branch)
  const hash = manifestHash(manifest)
  log.line(`[manifest] ${manifest.name} (${manifest.source})`)

  if (!registry.isApproved(app, hash, branch)) {
    const approval = approvalOf(app, manifest, branch, archiveGaps(checkout), registry.approvedCommands(app, branch))
    // Someone else's fork: what it changes in what `npm install` and the like really run.
    if (approval.foreign && app.repo) {
      emit('manifest', `Comparing what runs at install with ${app.repo}…`)
      approval.install = await reviewInstall(checkout, app.repo, approval.commands)
      log.line(
        approval.install.unavailable
          ? `[approval] install files not compared: ${approval.install.unavailable}`
          : `[approval] install files changed against ${app.repo}: ${approval.install.changes.map((c) => c.file).join(', ') || 'none'}`
      )
    }
    throw new ApprovalRequired(approval)
  }

  const start = startFor(manifest)
  if (start.mode === 'android' && start.artifact && branch.kind === 'github') {
    // An artifact that cannot be fetched, or holds no APK, is no reason not to build here.
    const apk = await fetchPrebuilt(app, branch, start.artifact, sha, log, emit, signal).catch((err: Error) => {
      if (signal.aborted) throw err
      log.line(`[prebuilt] ${err.message.split('\n')[0]} — building the APK here`)
      return undefined
    })
    if (apk) {
      const built = patchState(app.id, branch.key, { sha, builtSha: sha, manifestHash: hash, apk, lastCheck: new Date().toISOString() })
      emit('done', `Ready (${sha.slice(0, 7)}, built by GitHub Actions)`)
      return { checkout, manifest, state: built, toolchain: await bareToolchain(manifest) }
    }
  }

  emit('runtime', 'Preparing the runtimes…')
  const toolchain = await buildToolchain(manifest, log, checkout)

  await linkShares(app.id, checkout, manifest)

  // An environment depends on the files that pin it, on the runtime it was built
  // with — native modules target one ABI — and on the commands that installed it.
  const installed = JSON.stringify(manifest.install ?? [])
  const nodeKey = toolchain.node
    ? await keyOf(checkout, manifest.cacheKeys?.node ?? ['package-lock.json'], [toolchain.node.id, installed])
    : undefined
  const pythonKey = toolchain.python
    ? await keyOf(checkout, manifest.cacheKeys?.python ?? ['requirements.txt'], [toolchain.python.id, installed])
    : undefined
  // Recorded before the stores are touched, so a prune running meanwhile keeps them.
  patchState(app.id, branch.key, { nodeKey, pythonKey })
  // An install stopped by a full disk leaves half a tree behind: better not to begin one.
  if (!isInstalled(nodeKey, pythonKey)) await ensureFreeSpace(rootDir())

  if (pythonKey) {
    toolchain.venvPython = await ensureVenv(pythonKey, toolchain, log, emit, signal)
  }

  const nodeModules = join(checkout, 'node_modules')
  if (isInstalled(nodeKey, pythonKey)) {
    if (nodeKey) await linkDir(nodeModules, nodeModulesStore(nodeKey))
    log.line('[install] environments already prepared — reusing them')
    emit('install', 'Dependencies already cached')
  } else {
    // npm would replace a link with a real directory anyway: it installs beside the
    // shared store, never through it, and the result is adopted afterwards.
    if (nodeKey) await removePath(nodeModules)
    await runSteps('install', stepsFor(manifest.install), checkout, toolchain, log, emit, signal)
    if (nodeKey) await adoptNodeModules(checkout, nodeKey, log)
    if (pythonKey) await writeFile(markerPath('venv', pythonKey), pythonKey, 'utf-8')
  }

  await runSteps('build', stepsFor(manifest.build), checkout, toolchain, log, emit, signal)
  // Said at the build, where it failed, rather than at the start.
  if (start.mode === 'android') log.line(`[build] APK: ${relative(checkout, findApk(checkout, start.apk))}`)

  let electronBinary: string | undefined
  let electronMajor: string | undefined
  if (startFor(manifest).mode === 'electron') {
    electronMajor = expectedElectronMajor(checkout)
    if (needsOwnElectron(electronMajor)) {
      emit('runtime', 'Fetching the Electron runtime of the branch…')
      try {
        electronBinary = await resolveElectronBinary({ toolchain, cwd: checkout, log, signal })
      } catch (err) {
        // The install produced a tree without a usable Electron; invalidate it or
        // every retry skips the install and fails at the very same point.
        if (nodeKey) await removePath(markerPath('node', nodeKey))
        throw err
      }
    }
  }

  const built = patchState(app.id, branch.key, {
    sha,
    builtSha: sha,
    manifestHash: hash,
    electronMajor,
    electronBinary,
    apk: undefined,
    lastCheck: new Date().toISOString()
  })
  emit('done', `Ready (${sha.slice(0, 7)})`)
  return { checkout, manifest, state: built, toolchain }
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function buildToolchain(manifest: Manifest, log: BranchLog, checkout: string): Promise<Toolchain> {
  const proxy = await systemProxy()
  if (proxy) log.line(`[network] system proxy ${proxy}`)
  const toolchain: Toolchain = { pathDirs: [], env: manifest.env, proxy }

  if (wants(manifest, 'node')) {
    const node = await ensureNode(manifest.runtime?.node, log)
    toolchain.node = node
    toolchain.pathDirs.push(await ensureShims(node.id, node.bin), node.dir)
  }
  if (wants(manifest, 'python')) {
    const uvBin = await ensureUv(log)
    const python = await ensurePython(manifest.runtime?.python, uvBin, log, proxy)
    toolchain.python = python
    toolchain.uvBin = uvBin
    toolchain.pathDirs.push(python.dir, dirname(uvBin))
  }
  if (wants(manifest, 'java')) toolchain.java = await ensureJava(manifest.runtime?.java, log)
  if (wants(manifest, 'android')) {
    toolchain.androidSdk = await ensureAndroidSdk(toolchain, log, compilePlatform(checkout))
    await gradleSettings()
  }
  if (wants(manifest, 'flutter')) {
    const git = await ensureGit(log)
    if (git) toolchain.pathDirs.push(git)
    toolchain.flutter = await ensureFlutter(manifest.runtime?.flutter, log)
  }
  addMobile(toolchain)
  return toolchain
}

/**
 * Gradle without a daemon, and Kotlin compiled inside it: a daemon left running would hold the
 * checkout's files, and the next update could not replace them. Written in TryMyDev's Gradle
 * home, whose settings come before a project's.
 */
async function gradleSettings(): Promise<void> {
  await mkdir(cacheDir('gradle'), { recursive: true })
  await writeFile(
    join(cacheDir('gradle'), 'gradle.properties'),
    'org.gradle.daemon=false\nkotlin.compiler.execution.strategy=in-process\n',
    'utf-8'
  )
}

/** The platform the application module compiles against, read from its Gradle build. */
function compilePlatform(checkout: string): string | undefined {
  for (const file of ['app/build.gradle', 'app/build.gradle.kts', 'android/app/build.gradle', 'android/app/build.gradle.kts']) {
    try {
      const platform = platformOf(readFileSync(join(checkout, file), 'utf-8'))
      if (platform) return platform
    } catch {
      /* not this layout */
    }
  }
  return undefined
}

/** The JDK, the Android SDK and Flutter on PATH, as the manifest's commands expect them. */
function addMobile(toolchain: Toolchain): void {
  if (toolchain.java) toolchain.pathDirs.push(join(toolchain.java.home, 'bin'))
  if (toolchain.androidSdk) toolchain.pathDirs.push(join(toolchain.androidSdk, 'platform-tools'))
  if (toolchain.flutter) toolchain.pathDirs.push(join(toolchain.flutter.root, 'bin'))
}

/** What a start that builds nothing needs: the proxy, and the manifest's variables. */
async function bareToolchain(manifest: Manifest): Promise<Toolchain> {
  return { pathDirs: [], env: manifest.env, proxy: await systemProxy() }
}

/** The APK a workflow built from this commit, extracted into the branch folder, relative to it. */
async function fetchPrebuilt(
  app: App,
  branch: Branch & GithubSource,
  name: string,
  sha: string,
  log: BranchLog,
  emit: Emit,
  signal: AbortSignal
): Promise<string | undefined> {
  const repos = [`${branch.owner}/${branch.repo}`, ...(app.repo ? [app.repo] : [])]
  const artifact = await findArtifact(repos, name, sha).catch((err: Error) => {
    log.line(`[prebuilt] ${err.message}`)
    return undefined
  })
  if (!artifact) {
    log.line(
      githubToken()
        ? `[prebuilt] no "${name}" artifact built from ${sha.slice(0, 7)}: building the APK here`
        : '[prebuilt] GitHub serves workflow artifacts with a token only (Settings): building the APK here'
    )
    return undefined
  }
  const base = branchDir(app.id, branch.key)
  const dir = join(base, 'prebuilt')
  const zip = join(tmpDir(), `${branch.key}-${artifact.id}.zip`)
  const progress = (received: number, total: number): void =>
    emit('download', `Downloading the APK built by GitHub Actions… ${(received / 1024 / 1024).toFixed(1)} MB`, total ? Math.round((received / total) * 100) : undefined)
  emit('download', `Downloading the APK built by GitHub Actions (${artifact.repo})…`, 0)
  await mkdir(tmpDir(), { recursive: true })
  try {
    await downloadArtifact(artifact, zip, progress, signal)
    await removeTree(dir)
    await mkdir(dir, { recursive: true })
    await extract(zip, dir, 0)
  } finally {
    await unlink(zip).catch(() => undefined)
  }
  const apk = findApk(dir)
  log.line(`[prebuilt] ${name} from ${artifact.repo}, artifact ${artifact.id}: ${relative(dir, apk)}`)
  return relative(base, apk)
}

/** Same toolchain, but only from what is already on disk — used by the fast path. */
async function cachedToolchain(manifest: Manifest, state: BranchState): Promise<Toolchain | null> {
  const toolchain: Toolchain = { pathDirs: [], env: manifest.env, proxy: await systemProxy() }

  if (wants(manifest, 'node')) {
    const node = cachedNode(manifest.runtime?.node)
    if (!node) return null
    toolchain.node = node
    toolchain.pathDirs.push(await ensureShims(node.id, node.bin), node.dir)
  }
  if (wants(manifest, 'python')) {
    if (!state.pythonKey) return null
    const venvPython = venvInterpreter(venvStore(state.pythonKey))
    // A start command may be `uv run …` or `pip …`: the same uv as when it was built.
    const uvBin = await cachedUv()
    if (!existsSync(venvPython) || !uvBin) return null
    toolchain.venvPython = venvPython
    toolchain.uvBin = uvBin
    toolchain.pathDirs.push(join(venvPython, '..'), dirname(uvBin))
  }
  if (wants(manifest, 'java')) {
    const java = cachedJava(manifest.runtime?.java)
    if (!java) return null
    toolchain.java = java
  }
  if (wants(manifest, 'android')) {
    toolchain.androidSdk = cachedAndroidSdk()
    if (!toolchain.androidSdk) return null
  }
  if (wants(manifest, 'flutter')) {
    const git = cachedGit()
    const flutter = cachedFlutter(manifest.runtime?.flutter)
    if (git === null || !flutter) return null
    if (git) toolchain.pathDirs.push(git)
    toolchain.flutter = flutter
  }
  addMobile(toolchain)
  return toolchain
}

async function fetchSources(
  app: App,
  branch: Branch,
  sha: string,
  log: BranchLog,
  emit: Emit,
  signal: AbortSignal
): Promise<void> {
  const checkout = checkoutDir(app.id, branch.key)
  const staging = join(branchDir(app.id, branch.key), 'checkout.new')
  const archive = join(tmpDir(), `${branch.key}-${sha.slice(0, 7)}.tar.gz`)

  await mkdir(tmpDir(), { recursive: true })
  await removePath(staging)
  await mkdir(staging, { recursive: true })

  emit('download', branch.kind === 'local' ? 'Reading the sources from the clone…' : 'Downloading the sources…', 0)
  try {
    await fetchArchive(
      branch,
      sha,
      archive,
      (received, total) => {
        const mb = (received / 1024 / 1024).toFixed(1)
        emit('download', `Downloading the sources… ${mb} MB`, total ? Math.round((received / total) * 100) : undefined)
      },
      signal
    )
    signal.throwIfAborted()

    emit('download', 'Extracting…')
    // An entry that cannot be written — a symbolic link on Windows without developer
    // mode — is skipped by tar: said in the log, it explains what differs between machines.
    await tar.x({
      file: archive,
      cwd: staging,
      strip: 1,
      onwarn: (_code: string, message: string | Error) => log.line(`[download] skipped: ${String(message)}`)
    })
  } finally {
    await unlink(archive).catch(() => undefined)
  }

  // node_modules and the shared directories are links into the stores: they go
  // first, so the delete never reaches the caches behind them.
  await removeTree(checkout)
  await renameRetrying(staging, checkout)
  log.line(`[download] ${sha.slice(0, 7)} extracted`)
  for (const gap of archiveGaps(checkout)) log.line(`[download] warning: ${gap}`)
}

/** What an archive of the sources leaves out — said before it turns into a puzzling failure. */
export function archiveGaps(checkout: string): string[] {
  const gaps: string[] = []
  if (existsSync(join(checkout, '.gitmodules'))) {
    gaps.push('The project uses Git submodules, which source archives do not include: their folders arrive empty.')
  }
  let attributes = ''
  try {
    attributes = readFileSync(join(checkout, '.gitattributes'), 'utf-8')
  } catch {
    /* no attributes */
  }
  if (/filter=lfs/.test(attributes)) {
    gaps.push('The project stores files with Git LFS: source archives carry small pointer files instead of their content.')
  }
  return gaps
}

async function runSteps(
  phase: 'install' | 'build',
  steps: Step[],
  checkout: string,
  toolchain: Toolchain,
  log: BranchLog,
  emit: Emit,
  signal: AbortSignal
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    signal.throwIfAborted()
    emit(phase, `${phase === 'install' ? 'Installing' : 'Building'} — ${step.run}`, steps.length > 1 ? Math.round((index / steps.length) * 100) : undefined)
    await run(step.run, {
      toolchain,
      cwd: step.cwd ? join(checkout, step.cwd) : checkout,
      log,
      signal
    })
  }
}

// ── Environments ──────────────────────────────────────────────────────────────

async function keyOf(checkout: string, files: string[], salt: string[]): Promise<string | undefined> {
  const parts: string[] = []
  for (const file of files) {
    const path = join(checkout, file)
    if (existsSync(path)) parts.push(await sha256File(path))
  }
  return parts.length > 0 ? hashString([...parts, ...salt].join('\n')).slice(0, 32) : undefined
}

function venvInterpreter(dir: string): string {
  return process.platform === 'win32'
    ? join(dir, 'Scripts', 'python.exe')
    : join(dir, 'bin', 'python')
}

/**
 * One environment per set of requirements, shared by every branch that pins the
 * same ones. uv hardlinks each wheel from a global cache, so a branch that
 * changes a single dependency gets a complete environment for almost no disk.
 */
async function ensureVenv(
  key: string,
  toolchain: Toolchain,
  log: BranchLog,
  emit: Emit,
  signal: AbortSignal
): Promise<string> {
  const dir = venvStore(key)
  const python = venvInterpreter(dir)

  return withLock(`venv:${key}`, async () => {
    if (existsSync(python)) {
      log.line(`[venv] ${key.slice(0, 8)} reused`)
      return python
    }
    emit('install', 'Creating the Python environment…')
    // Whatever an interrupted attempt left behind is started over.
    await removePath(dir)
    await mkdir(dirname(dir), { recursive: true })
    await run(`uv venv "${dir}" --python "${toolchain.python?.bin ?? 'python'}"`, {
      toolchain,
      cwd: dirname(dir),
      log,
      signal
    })
    if (!existsSync(python)) throw new Error(`Virtual environment not created at ${dir}`)
    return python
  })
}

function markerPath(kind: 'node' | 'venv', key: string): string {
  return kind === 'node' ? join(nodeCacheDir(key), '.installed') : join(venvStore(key), '.installed')
}

function isInstalled(nodeKey?: string, pythonKey?: string): boolean {
  if (!nodeKey && !pythonKey) return false
  if (nodeKey && !existsSync(markerPath('node', nodeKey))) return false
  if (pythonKey && !existsSync(markerPath('venv', pythonKey))) return false
  return true
}

/**
 * The install lands inside the checkout; it moves into the shared store and is
 * linked back, so the next branch on the same lockfile installs nothing at all.
 * When another branch completed the store meanwhile, that one is kept — something
 * may be running from it — and this copy is dropped.
 */
async function adoptNodeModules(checkout: string, key: string, log: BranchLog): Promise<void> {
  const local = join(checkout, 'node_modules')
  if (!existsSync(local) || (await lstat(local)).isSymbolicLink()) return

  await withLock(`node-deps:${key}`, async () => {
    const marker = markerPath('node', key)
    if (existsSync(marker)) {
      log.line('[install] the shared cache was completed meanwhile — using it')
      await removePath(local)
    } else {
      log.line('[install] moving node_modules into the shared cache')
      await moveDir(local, nodeModulesStore(key))
    }
    await linkDir(local, nodeModulesStore(key))
    await writeFile(marker, key, 'utf-8')
  })
}

/** Heavy directories that belong to the application rather than to one branch. */
async function linkShares(appId: string, checkout: string, manifest: Manifest): Promise<void> {
  for (const share of manifest.share ?? []) {
    await linkDir(join(checkout, share.path), appShared(appId, share.path))
  }
}
