import crossSpawn from 'cross-spawn'
import { copyFile, mkdtemp, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join, normalize, resolve } from 'path'
import { hashString } from './fsx'
import { upstreamOf } from './github'
import { isAbsolutePath, type ParsedInput } from './source-url'
import type { LocalSource } from './types'

/**
 * A clone on this computer, read with the git the developer already has: no network, no
 * token, nothing pushed. Every command gets its arguments as a list — no shell.
 */

export class GitMissing extends Error {
  constructor() {
    super(
      'Git is not installed, or not on PATH. Local repositories are read with Git: ' +
        'install it from https://git-scm.com, then restart TryMyDev.'
    )
  }
}

/** git's own variables would point every command at another repository. */
const GIT_LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (GIT_LOCATION.includes(name.toUpperCase())) delete env[name]
  }
  return env
}

/**
 * Through cross-spawn, like every other command: a git installed as `git.cmd` (Scoop, some
 * wrappers) is found and its arguments escaped. `trim` off for output whose leading spaces
 * mean something, such as `status --porcelain`.
 */
export function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, trim = true): Promise<string> {
  return new Promise((resolve, reject) => {
    // A repository's own config can name a program git runs to list changes: not before approval.
    const child = crossSpawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env: { ...gitEnv(), ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', (error: NodeJS.ErrnoException) => {
      // The folder is checked first: ENOENT here is git itself.
      reject(error.code === 'ENOENT' ? new GitMissing() : error)
    })
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8')
      if (code === 0) return resolve(trim ? stdout.trim() : stdout)
      const command = args.find((arg) => !arg.startsWith('-')) ?? args[0]
      const stderr = Buffer.concat(err).toString('utf8').trim()
      reject(new Error(`git ${command} failed: ${stderr || (signal ? `stopped by ${signal}` : `exit code ${code}`)}`))
    })
  })
}

async function requireFolder(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`Folder not found: ${path}`)
}

/** git's exit codes often say "no" rather than "failed" — but a missing git still reaches the tester. */
async function gitOr<T>(args: string[], cwd: string, otherwise: T): Promise<string | T> {
  try {
    return await git(args, cwd)
  } catch (err) {
    if (err instanceof GitMissing) throw err
    return otherwise
  }
}

const OBJECT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** The filters Git LFS installs: what a repository's own config may declare. */
const LFS_FILTER = /^git-lfs (clean|smudge|filter-process)\b/

/**
 * A filter the repository's own config declares runs its program on `add`, `archive` and even
 * `status` — before any approval: such a folder is refused. Reading the config runs nothing.
 */
export async function refuseOwnFilters(top: string): Promise<void> {
  const out = await gitOr(['config', '--show-scope', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], top, '')
  const own = out
    .split(/\r?\n/)
    .map((line) => line.match(/^(local|worktree)\t(\S+) (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null && !LFS_FILTER.test(m[3]))
    .map((m) => m[2])
  if (own.length > 0) {
    throw new Error(
      `${top} declares Git filters in its own config (${own.join(', ')}): Git would run their programs as soon as ` +
        'TryMyDev reads the folder, before you approve anything. Remove them from .git/config, or start a ' +
        'GitHub branch instead.'
    )
  }
}

/** A branch name git would accept — never an option, a revision expression or `@{-1}`. */
export async function checkBranchName(ref: string, cwd: string): Promise<void> {
  const invalid = new Error(`Not a valid branch name: "${ref}"`)
  if (ref === '' || ref.startsWith('-') || ref.includes('@{') || ref.trim() !== ref) throw invalid
  if ((await gitOr(['check-ref-format', '--branch', ref], cwd, undefined)) !== ref) throw invalid
}

async function currentBranch(top: string): Promise<string | undefined> {
  return (await gitOr(['symbolic-ref', '--quiet', '--short', 'HEAD'], top, '')) || undefined
}

/** The branch's commit; under refs/heads, so neither a tag nor a remote branch of that name. */
async function commitOf(top: string, ref: string): Promise<string> {
  const sha = await gitOr(['rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`], top, '')
  if (!OBJECT_RE.test(sha)) throw new Error(`No branch "${ref}" in ${top}.`)
  return sha
}

/** `owner/repo` of a GitHub remote, over HTTPS or SSH. */
export function githubRemote(url: string): { owner: string; repo: string } | undefined {
  const match = url
    .trim()
    .match(/^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  return match ? { owner: match[1], repo: match[2] } : undefined
}

export interface LocalResolved {
  source: LocalSource
  /** `owner/repo` of the application, when origin is on GitHub: a clone of Modly is Modly. */
  upstream?: string
  /** The folder's name, for an application of its own. */
  name: string
}

/** The commit checked out, whatever the branch — or none, detached HEAD included. */
async function headCommit(top: string): Promise<string> {
  const sha = await gitOr(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], top, '')
  if (!OBJECT_RE.test(sha)) throw new Error(`${top} has no commit yet: commit once, then try again.`)
  return sha
}

export async function resolveLocal(parsed: Extract<ParsedInput, { kind: 'local' }>): Promise<LocalResolved> {
  if (!isAbsolutePath(parsed.path)) {
    throw new Error(`Not an absolute path: ${parsed.path}\nGive the full path of the clone, such as C:\\Users\\me\\code\\project.`)
  }
  await requireFolder(parsed.path)
  const top = await gitOr(['rev-parse', '--show-toplevel'], parsed.path, '')
  if (!top) throw new Error(`${parsed.path} is not inside a Git working tree.`)
  const path = normalize(top)
  await refuseOwnFilters(path)

  if (parsed.ref !== undefined) {
    await checkBranchName(parsed.ref, path)
    await commitOf(path, parsed.ref)
  } else {
    await headCommit(path)
  }

  const github = githubRemote(await gitOr(['remote', 'get-url', 'origin'], path, ''))
  // The fork network's root, as for a fork pasted from GitHub; offline, the remote itself.
  const upstream = github
    ? await upstreamOf(github.owner, github.repo).catch(() => `${github.owner}/${github.repo}`)
    : undefined

  return {
    source: { kind: 'local', path, ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}) },
    upstream,
    name: basename(path)
  }
}

/**
 * Every file of the working tree git does not ignore — tracked, changed, staged or untracked —
 * as a tree. `git add -A` runs on a copy of the index: the developer's index, branch and stash
 * are left as they are, and the copy keeps git's file stat cache, so unchanged files are not
 * read again. The same files give the same tree, which the build cache relies on.
 */
async function workingTree(top: string): Promise<string> {
  const index = resolve(top, await git(['rev-parse', '--git-path', 'index'], top))
  const scratch = await mkdtemp(join(tmpdir(), 'trymydev-index-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    await copyFile(index, env.GIT_INDEX_FILE).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
    await git(['add', '--all', '--', '.'], top, env)
    const tree = await git(['write-tree'], top, env)
    if (!OBJECT_RE.test(tree)) throw new Error(`git gave no tree for the working tree of ${top}.`)
    return tree
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The folder's state, read without writing anything — no object, no index refresh: HEAD, what
 * `git status` lists, and the size and time of each file listed, since a file stays listed
 * however often it changes again. Equal fingerprints, equal trees: the tree is only built when
 * this moved.
 */
export async function folderFingerprint(top: string): Promise<string> {
  const parts = [await headCommit(top)]
  const entries = (
    await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], top, {}, false)
  ).split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    // A rename or a copy is followed by the path it came from.
    if (entry[0] === 'R' || entry[0] === 'C') i++
    const info = await stat(join(top, entry.slice(3))).catch(() => undefined)
    parts.push(`${entry}\t${info ? `${info.size}:${info.mtimeMs}` : 'gone'}`)
  }
  return hashString(parts.join('\n'))
}

/**
 * Untracked files .gitignore lets through go into every build, and git keeps each version of
 * them in the repository until it collects garbage: past this, the start stops and says which.
 * Mutable for the tests only.
 */
export const UNTRACKED_LIMIT = { bytes: 100 * 1024 * 1024, files: 10_000 }

const size = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`

async function checkUntracked(top: string): Promise<void> {
  const paths = (await git(['ls-files', '--others', '--exclude-standard', '-z'], top, {}, false)).split('\0').filter(Boolean)
  let total = 0
  const sized: Array<{ path: string; bytes: number }> = []
  for (const path of paths.slice(0, UNTRACKED_LIMIT.files + 1)) {
    const info = await stat(join(top, path)).catch(() => undefined)
    if (!info?.isFile()) continue
    total += info.size
    sized.push({ path, bytes: info.size })
  }
  if (paths.length <= UNTRACKED_LIMIT.files && total <= UNTRACKED_LIMIT.bytes) return

  let detail: string[]
  if (paths.length > UNTRACKED_LIMIT.files) {
    const byFolder = new Map<string, number>()
    for (const path of paths) {
      const folder = path.split('/').slice(0, 2).join('/')
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1)
    }
    detail = [...byFolder].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([folder, count]) => `  ${folder}  ${count} files`)
  } else {
    detail = sized.sort((a, b) => b.bytes - a.bytes).slice(0, 8).map((f) => `  ${f.path}  ${size(f.bytes)}`)
  }
  throw new Error(
    `${top} holds ${paths.length} untracked file(s) that .gitignore does not exclude` +
      `${paths.length > UNTRACKED_LIMIT.files ? '' : `, ${size(total)}`} — more than TryMyDev copies into a build ` +
      `(${size(UNTRACKED_LIMIT.bytes)} or ${UNTRACKED_LIMIT.files} files). The largest:\n${detail.join('\n')}\n` +
      `Add them to .gitignore (or .git/info/exclude), or start a branch's last commit instead: ${top}@branch-name`
  )
}

/**
 * `.env` files .gitignore keeps out — at the top and one folder down. The build lacks them, as
 * a tester's would: said before the application fails for a missing setting.
 */
async function ignoredEnvFiles(top: string): Promise<string[]> {
  const found: string[] = []
  const look = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(top, dir), { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && /^\.env(\..+)?$/.test(entry.name) && !/\.(example|sample|template|dist)$/.test(entry.name)) {
        found.push(dir ? `${dir}/${entry.name}` : entry.name)
      }
    }
  }
  await look('')
  for (const entry of await readdir(top, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') await look(entry.name)
  }
  if (found.length === 0) return []
  return (await gitOr(['-c', 'core.quotepath=off', 'check-ignore', '--', ...found], top, '')).split(/\r?\n/).filter(Boolean)
}

/** What a start builds, and what `known` — the last sources read — still stands for. */
export interface LocalHead {
  sha: string
  /** The folder as it is only: what it looked like when `sha` was computed. */
  fingerprint?: string
  warnings?: string[]
}

/**
 * What a start builds: a named branch's last commit — or the folder as it is: whatever is
 * checked out, with every change and every file not ignored. Its commit when nothing differs,
 * else the tree of the working folder; the one already known when the folder has not moved.
 */
export async function localHead(
  src: LocalSource,
  log?: (line: string) => void,
  known?: { sha: string; fingerprint?: string }
): Promise<LocalHead> {
  await requireFolder(src.path)
  await refuseOwnFilters(src.path)
  if (src.ref !== undefined) return { sha: await commitOf(src.path, src.ref) }

  const fingerprint = await folderFingerprint(src.path)
  if (known && known.fingerprint === fingerprint) {
    log?.('[resolve] folder unchanged since its sources were last read')
    return { sha: known.sha, fingerprint }
  }

  const commit = await headCommit(src.path)
  const on = (await currentBranch(src.path)) ?? `detached HEAD ${commit.slice(0, 7)}`
  await checkUntracked(src.path)
  const tree = await workingTree(src.path)
  const warnings = (await ignoredEnvFiles(src.path)).map(
    (file) => `${file} is left out: .gitignore excludes it, so the build lacks it — as a tester's would.`
  )
  if (tree === (await git(['rev-parse', '--verify', `${commit}^{tree}`], src.path))) {
    log?.(`[resolve] folder as it is: ${on}, nothing uncommitted`)
    return { sha: commit, fingerprint, warnings }
  }
  log?.(`[resolve] folder as it is: ${on}, uncommitted and untracked files included (tree ${tree.slice(0, 7)})`)
  return { sha: tree, fingerprint, warnings }
}

/**
 * The same answer for a check nobody asked for, written nowhere: a folder that moved since
 * `known` gives its fingerprint, which differs from any sha, rather than a tree built for it.
 */
export async function peekLocal(src: LocalSource, known?: { sha: string; fingerprint?: string }): Promise<string> {
  await requireFolder(src.path)
  await refuseOwnFilters(src.path)
  if (src.ref !== undefined) return commitOf(src.path, src.ref)
  const fingerprint = await folderFingerprint(src.path)
  return known && known.fingerprint === fingerprint ? known.sha : fingerprint
}

/** The same archive GitHub serves: gzipped tar, everything under one top folder. */
export async function archiveLocal(src: LocalSource, object: string, dest: string): Promise<void> {
  if (!OBJECT_RE.test(object)) throw new Error(`Not a git object: ${object}`)
  await requireFolder(src.path)
  await refuseOwnFilters(src.path)
  await git(['archive', '--format=tar.gz', '--prefix=source/', '-o', dest, object], src.path)
}
