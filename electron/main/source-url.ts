import { existsSync } from 'fs'
import { hashString } from './fsx'
import type { Source } from './types'

export type ParsedInput =
  | {
      kind: 'github'
      owner: string
      repo: string
      /** Undefined when the input carries no ref — the default branch is resolved later. */
      ref?: string
      pr?: number
    }
  | {
      kind: 'local'
      path: string
      /** Undefined when the input carries no ref — the folder as it is. */
      ref?: string
    }

const OWNER_RE = '[A-Za-z0-9_.-]+'

/** Absolute on this system: a drive or a network share on Windows, the root elsewhere. */
export function isAbsolutePath(path: string): boolean {
  return process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(path) : path.startsWith('/')
}

/** Shaped like an absolute path on any system — then refused or accepted by `isAbsolutePath`. */
function looksLikePath(text: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(text)
}

/**
 * `C:\code\modly@feat/x` or `C:\code\modly`. The ref follows the last @, unless what follows
 * holds a backslash — no branch does — or the whole text is a folder: `C:\me@corp\modly`.
 */
function parseLocal(text: string): ParsedInput {
  const at = text.lastIndexOf('@')
  if (at > 0 && !text.slice(at + 1).includes('\\') && !existsSync(text)) {
    const ref = text.slice(at + 1).trim()
    return { kind: 'local', path: text.slice(0, at).trim(), ref: ref || undefined }
  }
  return { kind: 'local', path: text }
}

/**
 * Accepts what a tester can realistically paste:
 *   https://github.com/owner/repo/tree/feat/some-branch
 *   https://github.com/owner/repo/pull/42
 *   https://github.com/owner/repo(.git)
 *   owner/repo@feat/some-branch   |   owner/repo
 *   C:\code\repo@feat/some-branch |   /home/me/code/repo   (a local clone)
 */
export function parseInput(raw: string): ParsedInput {
  // Paths may hold spaces; "Copy as path" wraps them in quotes.
  const text = raw.trim().replace(/"/g, '')
  if (looksLikePath(text)) return parseLocal(text)

  const input = text.replace(/\s+/g, '')
  if (input === '') throw new Error('Empty address.')

  const url = input.match(
    new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER_RE})/(${OWNER_RE}?)(?:\\.git)?(/.*)?$`)
  )
  if (url) {
    const owner = url[1]
    const repo = url[2].replace(/\.git$/, '')
    const rest = url[3] ?? ''

    const pr = rest.match(/^\/pull\/(\d+)/)
    if (pr) return { kind: 'github', owner, repo, pr: Number(pr[1]) }

    const tree = rest.match(/^\/(?:tree|blob)\/(.+?)\/?$/)
    if (tree) return { kind: 'github', owner, repo, ref: decodeURIComponent(tree[1]) }

    return { kind: 'github', owner, repo }
  }

  const short = input.match(new RegExp(`^(${OWNER_RE})/(${OWNER_RE}?)(?:@(.+))?$`))
  if (short) {
    return { kind: 'github', owner: short[1], repo: short[2].replace(/\.git$/, ''), ref: short[3] }
  }

  throw new Error(
    `Unrecognised address: ${raw}\n` +
      'Accepted examples:\n' +
      '  https://github.com/lightningpixel/modly/tree/feat/api-token-and-agent-guards\n' +
      '  https://github.com/owner/modly/pull/42\n' +
      '  owner/modly@my-branch\n' +
      '  C:\\Users\\me\\code\\modly@my-branch   (a local clone, by its absolute path)'
  )
}

/** A local path as an identity: Windows ignores case. */
export function pathIdentity(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** Where the code comes from, for a person: `owner/repo`, or the folder of a clone. */
export function sourceName(src: Source): string {
  return src.kind === 'local' ? src.path : `${src.owner}/${src.repo}`
}

/** The ref, for a person: a local folder followed as it is has none. */
export function refLabel(src: Source): string {
  return src.ref ?? 'working tree'
}

/** `owner/repo · ref (PR #n)`, or the folder of a clone and its ref. */
export function sourceLabel(src: Source): string {
  const pr = src.kind === 'github' && src.pr ? ` (PR #${src.pr})` : ''
  return `${sourceName(src)} · ${refLabel(src)}${pr}`
}

/** What `parseInput` reads back as this source: `owner/repo@ref`, or the folder and its ref. */
export function sourceAddress(src: Source): string {
  return `${sourceName(src)}${src.ref !== undefined ? `@${src.ref}` : ''}`
}

/** `owner/repo` on GitHub, whatever the case: undefined for a clone, known by its folder. */
export function githubRepo(src: Source): string | undefined {
  return src.kind === 'github' ? `${src.owner}/${src.repo}` : undefined
}

/**
 * `owner/repo` of the code a branch runs — what an approval trusts. A clone is its folder:
 * approving the repository on GitHub does not approve what a folder holds, nor the reverse.
 */
export function codeSource(src: Source): string {
  return src.kind === 'local' ? `local:${pathIdentity(src.path)}` : `${src.owner}/${src.repo}`.toLowerCase()
}

/** GitHub ignores the case of owners and repositories, Windows that of paths; refs are exact. */
export function sameSource(a: Source, b: Source): boolean {
  return a.ref === b.ref && codeSource(a) === codeSource(b)
}

/**
 * Folder name of one branch of one application: its ref, for a person reading the disk,
 * and a hash of everything, for uniqueness — "fix/login" and "fix-login", or "Dev" and
 * "dev", stay apart. Kept short: Windows allows 260 characters per path, and builds copy
 * deep node_modules trees into the checkout.
 */
export function branchKey(appId: string, src: Source): string {
  const ref = (src.ref ?? 'local')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 24)
    .replace(/[-.]+$/, '')
    .toLowerCase()
  const identity = `${appId}/${codeSource(src)}${src.ref !== undefined ? `@${src.ref}` : ''}`
  return `${ref || 'branch'}-${hashString(identity).slice(0, 8)}`
}
