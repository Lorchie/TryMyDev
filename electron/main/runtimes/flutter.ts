import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { withLock } from '../lock'
import { request } from '../network'
import { runtimeDir, storeDir } from '../paths'
import { fetchArchive } from './download'
import type { BranchLog } from '../logger'

/**
 * The Flutter SDK, from Google's release index, which carries each archive's sha256. The latest
 * stable release unless a manifest names one with `runtime.flutter` ("3.24.5"). Flutter keeps
 * its own caches inside the SDK: one folder per release, shared by every application.
 */

export interface FlutterRuntime {
  id: string
  /** FLUTTER_ROOT. */
  root: string
}

const BASE = 'https://storage.googleapis.com/flutter_infra_release/releases'

function os(): string {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
}

const rootOf = (id: string): string => runtimeDir('flutter', id)
const binOf = (root: string): string => join(root, 'bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter')

/** A release already on disk: the one asked for, else the newest. Never touches the network. */
export function cachedFlutter(version?: string): FlutterRuntime | null {
  let names: string[]
  try {
    names = readdirSync(join(storeDir(), 'flutter'))
  } catch {
    return null
  }
  const id = names
    .filter((name) => (version ? name === `flutter-${version}` : name.startsWith('flutter-')))
    .filter((name) => existsSync(binOf(rootOf(name))))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop()
  return id ? { id, root: rootOf(id) } : null
}

interface Release {
  hash: string
  channel: string
  version: string
  archive: string
  sha256: string
  dart_sdk_arch?: string
}

export async function ensureFlutter(version: string | undefined, log: BranchLog): Promise<FlutterRuntime> {
  const cached = cachedFlutter(version)
  if (cached) return cached

  const res = await request(`${BASE}/releases_${os()}.json`)
  if (!res.ok) throw new Error(`Could not list the Flutter releases (HTTP ${res.status}).`)
  const index = (await res.json()) as { current_release: { stable: string }; releases: Release[] }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const fits = (r: Release): boolean => !r.dart_sdk_arch || r.dart_sdk_arch === arch
  const release = version
    ? index.releases.find((r) => r.version === version && r.channel === 'stable' && fits(r))
    : index.releases.find((r) => r.hash === index.current_release.stable && fits(r))
  if (!release) throw new Error(`No Flutter ${version ?? 'stable'} release for ${os()} ${arch}.`)

  const id = `flutter-${release.version}`
  return withLock(`runtime:${id}`, async () => {
    if (!existsSync(binOf(rootOf(id)))) {
      log.line(`[runtime] Flutter ${release.version} (~1.5 GB, once for every application)`)
      await fetchArchive({ url: `${BASE}/${release.archive}`, dest: rootOf(id), checksum: { value: release.sha256 }, strip: 1, log })
      if (!existsSync(binOf(rootOf(id)))) throw new Error(`Flutter missing after extraction: ${binOf(rootOf(id))}`)
    }
    return { id, root: rootOf(id) }
  })
}
