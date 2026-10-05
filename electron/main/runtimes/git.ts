import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { withLock } from '../lock'
import { runtimeDir } from '../paths'
import { fetchArchive } from './download'
import type { BranchLog } from '../logger'

/**
 * Flutter is a Git checkout and its tool runs git to know its own version: without git, nothing
 * starts. Windows rarely has one; MinGit, Git for Windows' portable build, is put in the store.
 */
const VERSION = '2.56.0'

/** Digests copied from the v2.56.0.windows.1 release. */
const ARCHIVES: Record<string, { file: string; sha256: string }> = {
  x64: { file: 'MinGit-2.56.0-64-bit.zip', sha256: '064b440ff870ed5198527e8f3a92cdf5bd2fd0fedf5e718af95e3fdaddeff718' },
  arm64: { file: 'MinGit-2.56.0-arm64.zip', sha256: 'cb3b0f2d486ea52673227151a5baf5bc13861ff80e74e94e46d614d1bfcd5c06' }
}

const dir = (): string => runtimeDir('git', `mingit-${VERSION}-${process.arch}`)

function onPath(): boolean {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']
  return (process.env.PATH ?? '').split(delimiter).some((d) => d && names.some((n) => existsSync(join(d, n))))
}

/** A folder to put on PATH, or undefined when the system's git does. */
export async function ensureGit(log: BranchLog): Promise<string | undefined> {
  if (onPath() || process.platform !== 'win32') return undefined
  const cmd = join(dir(), 'cmd')
  if (existsSync(join(cmd, 'git.exe'))) return cmd
  const archive = ARCHIVES[process.arch] ?? ARCHIVES.x64
  return withLock(`runtime:mingit-${VERSION}`, async () => {
    if (!existsSync(join(cmd, 'git.exe'))) {
      log.line(`[runtime] MinGit ${VERSION}, for Flutter`)
      await fetchArchive({
        url: `https://github.com/git-for-windows/git/releases/download/v${VERSION}.windows.1/${archive.file}`,
        dest: dir(),
        checksum: { value: archive.sha256 },
        log
      })
    }
    return cmd
  })
}

/** The same, from the store only. */
export function cachedGit(): string | undefined | null {
  if (onPath() || process.platform !== 'win32') return undefined
  const cmd = join(dir(), 'cmd')
  return existsSync(join(cmd, 'git.exe')) ? cmd : null
}
