import { existsSync } from 'fs'
import { join } from 'path'
import { withLock } from '../lock'
import { runtimeDir } from '../paths'
import { fetchArchive } from './download'
import type { BranchLog } from '../logger'

/**
 * scrcpy (Genymobile, Apache 2.0) shows a phone's screen in a window of the computer and passes
 * the mouse and keyboard back: the tester uses the application there, or on the phone itself.
 */
const VERSION = '4.1'

/** Digests of the v4.1 archives, copied from the release's SHA256SUMS.txt. */
const ARCHIVES: Record<string, { file: string; sha256: string }> = {
  'win32-x64': { file: 'scrcpy-win64-v4.1.zip', sha256: '5b12172b3264b2889f4583ee64752ce832e29bc8b1089dca81093459697165db' },
  'win32-arm64': { file: 'scrcpy-win64-v4.1.zip', sha256: '5b12172b3264b2889f4583ee64752ce832e29bc8b1089dca81093459697165db' },
  'linux-x64': { file: 'scrcpy-linux-x86_64-v4.1.tar.gz', sha256: 'ad56ae8bfeedf41e824945c11dbf55fcb092b3e615b9b486f48a50e30d389635' },
  'darwin-arm64': { file: 'scrcpy-macos-aarch64-v4.1.tar.gz', sha256: '20fd47c9014dd5e0fa77091f3cb7adbda8445a360c4584aeaa0150b5b3988ff3' },
  'darwin-x64': { file: 'scrcpy-macos-x86_64-v4.1.tar.gz', sha256: 'ee2a7223bc8dbdc4f482db1134bcf441178dafb833492b71ca4c22090c58ce72' }
}

const id = (): string => `scrcpy-${VERSION}-${process.platform}-${process.arch}`
const binary = (): string => join(runtimeDir('scrcpy', id()), process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy')

export function cachedScrcpy(): string | undefined {
  return existsSync(binary()) ? binary() : undefined
}

/** Undefined where scrcpy publishes no build: the application still runs on the phone. */
export async function ensureScrcpy(log: BranchLog): Promise<string | undefined> {
  const cached = cachedScrcpy()
  if (cached) return cached
  const archive = ARCHIVES[`${process.platform}-${process.arch}`]
  if (!archive) {
    log.line(`[runtime] no screen mirroring on ${process.platform} ${process.arch}: use the phone itself`)
    return undefined
  }
  return withLock(`runtime:${id()}`, async () => {
    if (!existsSync(binary())) {
      log.line(`[runtime] scrcpy ${VERSION}`)
      await fetchArchive({
        url: `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/${archive.file}`,
        dest: runtimeDir('scrcpy', id()),
        checksum: { value: archive.sha256 },
        strip: 1,
        log
      })
    }
    if (!existsSync(binary())) throw new Error(`scrcpy missing after extraction: ${binary()}`)
    return binary()
  })
}
