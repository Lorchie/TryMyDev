import { downloadTarball, headSha, resolveSource } from './github'
import { archiveLocal, localHead, peekLocal, resolveLocal, type LocalHead } from './local-git'
import * as registry from './registry'
import { parseInput } from './source-url'
import type { App, Manifest, Source } from './types'

/** Where sources come from: the only place that tells GitHub and a local clone apart. */

export interface ResolvedInput {
  source: Source
  /** `owner/repo` of the application, when there is one on GitHub. */
  upstream?: string
  /** The application's name when it has no repository: the clone's folder. */
  name: string
}

export async function resolveInput(raw: string): Promise<ResolvedInput> {
  const parsed = parseInput(raw)
  if (parsed.kind === 'local') return resolveLocal(parsed)
  const { source, upstream } = await resolveSource(parsed)
  return { source, upstream, name: source.repo }
}

/** The application a source lands in: its upstream's, or one of its own for a clone with no GitHub remote. */
export function appFor(resolved: ResolvedInput, manifest?: Manifest): App {
  const repo = manifest?.repo ?? resolved.upstream
  if (repo) return registry.addApp(repo, manifest)
  if (resolved.source.kind !== 'local') throw new Error('A GitHub source always has a repository.')
  return registry.addLocalApp(resolved.source.path, resolved.name, manifest)
}

/** The last sources read for a branch: a local folder that has not moved still stands for them. */
export interface Known {
  sha: string
  fingerprint?: string
}

/** The commit — or tree — a start builds. */
export async function headOf(src: Source, log?: (line: string) => void, known?: Known): Promise<LocalHead> {
  return src.kind === 'local' ? localHead(src, log, known) : { sha: await headSha(src) }
}

/** The same for a check nobody asked for: a local folder is read, never written to. */
export function peekHead(src: Source, known?: Known): Promise<string> {
  return src.kind === 'local' ? peekLocal(src, known) : headSha(src)
}

export function fetchArchive(
  src: Source,
  sha: string,
  dest: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return src.kind === 'local' ? archiveLocal(src, sha, dest) : downloadTarball(src, sha, dest, onProgress, signal)
}
