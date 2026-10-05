import { readFile } from 'fs/promises'
import { join, posix } from 'path'
import { rawFile } from './github'
import type { InstallChange, InstallReview } from './types'

/**
 * What runs at install besides the manifest's commands: npm's lifecycle scripts and the packages
 * it fetches, pip's requirements, Gradle's build and the Gradle it downloads. The approval shows
 * `npm install`; these files say what it really does. A branch from someone else is compared with
 * the official project's default branch, file by file. Scripts only count when they run.
 */
export const INSTALL_FILES = [
  'package.json',
  'package-lock.json',
  '.npmrc',
  'requirements.txt',
  'api/requirements.txt',
  'pyproject.toml',
  'setup.py',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'app/build.gradle',
  'app/build.gradle.kts',
  'gradle/wrapper/gradle-wrapper.properties',
  'android/build.gradle',
  'android/app/build.gradle',
  'android/gradle/wrapper/gradle-wrapper.properties',
  'pubspec.yaml'
]

/** Lines shown per file: enough to judge, not a diff to read. */
const MAX_LINES = 12

const DEPENDENCIES = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** Scripts npm runs by itself when it installs: of the project, and of a git dependency. */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']

/** The scripts that run: npm's own at install, and those the commands name, with their pre and post. */
export function scriptsRun(commands: string[]): string[] {
  const named = commands.flatMap((command) => {
    const m = command.match(/^npm\s+(?:run|run-script)\s+(\S+)|^npm\s+(start|test)\b/)
    const name = m?.[1] ?? m?.[2]
    return name ? [`pre${name}`, name, `post${name}`] : []
  })
  return [...new Set([...LIFECYCLE, ...named])]
}

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function packageChanges(official: string | undefined, branch: string, run: string[]): string[] {
  let before: PackageJson
  let after: PackageJson
  try {
    before = official ? (JSON.parse(official) as PackageJson) : {}
    after = JSON.parse(branch) as PackageJson
  } catch {
    return ['Changed, and not readable as JSON.']
  }
  const lines: string[] = []
  let others = 0
  for (const [name, command] of Object.entries(after.scripts ?? {})) {
    const was = before.scripts?.[name]
    if (was === command) continue
    if (!run.includes(name)) others++
    else if (was === undefined) lines.push(`script "${name}" added: ${command}`)
    else lines.push(`script "${name}" now runs: ${command}`)
  }
  for (const field of DEPENDENCIES) {
    for (const [name, spec] of Object.entries(after[field] ?? {})) {
      const was = DEPENDENCIES.map((f) => before[f]?.[name]).find((s) => s !== undefined)
      if (was === undefined) lines.push(`dependency ${name} added: ${spec}`)
      else if (was !== spec) lines.push(`dependency ${name}: ${was} → ${spec}`)
    }
  }
  if (others > 0) lines.push(`${others} other script(s) changed — not run by these commands`)
  return lines
}

/** Packages a lockfile fetches from anywhere but the npm registry. */
function outsideRegistry(lock: string | undefined): Map<string, string> {
  const found = new Map<string, string>()
  if (!lock) return found
  let json: { packages?: Record<string, { resolved?: string }>; dependencies?: Record<string, { resolved?: string }> }
  try {
    json = JSON.parse(lock)
  } catch {
    return found
  }
  for (const [name, entry] of [...Object.entries(json.packages ?? {}), ...Object.entries(json.dependencies ?? {})]) {
    const url = entry.resolved
    if (url && !url.startsWith('https://registry.npmjs.org/')) found.set(url, name.replace(/^.*node_modules\//, '') || name)
  }
  return found
}

function lockChanges(official: string | undefined, branch: string): string[] {
  const known = outsideRegistry(official)
  return [...outsideRegistry(branch)]
    .filter(([url]) => !known.has(url))
    .map(([url, name]) => `package ${name} fetched from outside the npm registry: ${url}`)
}

/** Lines that say something: not blank, not a comment. */
const meaningful = (text: string | undefined): string[] =>
  (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'))

function textChanges(official: string | undefined, branch: string): string[] {
  const before = new Set(meaningful(official))
  const after = meaningful(branch)
  const now = new Set(after)
  const added = after.filter((line) => !before.has(line)).map((line) => `+ ${line}`)
  const removed = [...before].filter((line) => !now.has(line)).length
  return removed > 0 ? [...added, `${removed} line(s) removed`] : added
}

/** What a branch's version of one install file changes, for a person deciding whether to run it. */
export function changesOf(file: string, official: string | undefined, branch: string | undefined, run = LIFECYCLE): string[] {
  if (branch === undefined || branch === official) return []
  const lines = file.endsWith('package.json')
    ? packageChanges(official, branch, run)
    : file.endsWith('package-lock.json')
      ? lockChanges(official, branch)
      : textChanges(official, branch)
  if (official === undefined && lines.length === 0) return []
  if (lines.length <= MAX_LINES) return lines
  return [...lines.slice(0, MAX_LINES), `… and ${lines.length - MAX_LINES} more`]
}

/**
 * Scripts of the project the install and build commands run themselves — `node scripts/x.js`,
 * `python setup_env.py` — as an approval line shows them. The last line is the start: the
 * application itself, not its installation.
 */
export function filesRun(commands: string[]): string[] {
  const files = commands.slice(0, -1).flatMap((line) => {
    const [command, cwd] = line.split(/\s{4}\(in (.+)\)$/)
    const file = command.match(/^(?:node|python3?|uv run)\s+([\w./-]+\.(?:m?js|cjs|py))(?:\s|$)/)?.[1]
    if (!file || file.startsWith('/')) return []
    return [posix.normalize(cwd ? `${cwd}/${file}` : file)]
  })
  return [...new Set(files)].filter((file) => !file.startsWith('..'))
}

const readOrUndefined = (path: string): Promise<string | undefined> => readFile(path, 'utf-8').catch(() => undefined)

/**
 * The install files of a checkout against those of `official`'s default branch. Never throws: a
 * comparison GitHub cannot serve says so, and the approval goes on without it.
 */
export async function reviewInstall(checkout: string, official: string, commands: string[] = []): Promise<InstallReview> {
  const run = scriptsRun(commands)
  const present = (
    await Promise.all([...new Set([...INSTALL_FILES, ...filesRun(commands)])].map(async (file) => ({ file, text: await readOrUndefined(join(checkout, file)) })))
  ).filter((f): f is { file: string; text: string } => f.text !== undefined)
  try {
    const changes: InstallChange[] = []
    const officials = await Promise.all(present.map((f) => rawFile(official, f.file)))
    present.forEach(({ file, text }, i) => {
      const lines = changesOf(file, officials[i], text, run)
      if (lines.length > 0) changes.push({ file, added: officials[i] === undefined, lines })
    })
    return { against: official, changes }
  } catch (err) {
    return { against: official, changes: [], unavailable: (err as Error).message }
  }
}
