import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { withLock } from '../lock'
import { request } from '../network'
import { runtimeDir, storeDir } from '../paths'
import { fetchArchive } from './download'
import type { BranchLog } from '../logger'

/**
 * Gradle and the Android SDK tools run on a JDK. Eclipse Temurin, from the Adoptium API, which
 * gives the archive's sha256 beside its address. 17 builds every Android Gradle plugin from 7.0;
 * a manifest asks for another major with `runtime.java`.
 */
const DEFAULT_MAJOR = '17'

export interface JavaRuntime {
  id: string
  /** JAVA_HOME. */
  home: string
  bin: string
}

function platform(): { os: string; arch: string } {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  if (process.platform === 'win32') return { os: 'windows', arch }
  if (process.platform === 'darwin') return { os: 'mac', arch }
  return { os: 'linux', arch }
}

function major(version?: string): string {
  return (version ?? '').match(/\d+/)?.[0] ?? DEFAULT_MAJOR
}

/** macOS archives put the JDK under Contents/Home. */
function homeOf(dir: string): string {
  return process.platform === 'darwin' ? join(dir, 'Contents', 'Home') : dir
}

function binOf(home: string): string {
  return join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
}

/** Gradle compiles with javac: a JDK missing it — a cleaner emptied the folder — is fetched again. */
function complete(home: string): boolean {
  return existsSync(binOf(home)) && existsSync(join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))
}

/** The newest JDK of a major line already on disk. Never touches the network. */
export function cachedJava(version?: string): JavaRuntime | null {
  const wanted = major(version)
  let names: string[]
  try {
    names = readdirSync(join(storeDir(), 'java'))
  } catch {
    return null
  }
  const { os, arch } = platform()
  const id = names
    .filter((name) => name.startsWith(`jdk-${wanted}.`) && name.endsWith(`-${os}-${arch}`))
    .filter((name) => complete(homeOf(runtimeDir('java', name))))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop()
  if (!id) return null
  const home = homeOf(runtimeDir('java', id))
  return { id, home, bin: binOf(home) }
}

interface AdoptiumAsset {
  version: { semver: string }
  binary: { package: { name: string; link: string; checksum: string } }
}

export async function ensureJava(version: string | undefined, log: BranchLog): Promise<JavaRuntime> {
  const cached = cachedJava(version)
  if (cached) return cached

  const wanted = major(version)
  const { os, arch } = platform()
  const res = await request(
    `https://api.adoptium.net/v3/assets/latest/${wanted}/hotspot?os=${os}&architecture=${arch}&image_type=jdk&vendor=eclipse`
  )
  if (!res.ok) throw new Error(`Could not list the Java ${wanted} releases (HTTP ${res.status}).`)
  const asset = ((await res.json()) as AdoptiumAsset[])[0]
  if (!asset) throw new Error(`No Java ${wanted} build for ${os} ${arch}.`)

  const id = `jdk-${asset.version.semver.replace(/\+.*/, '')}-${os}-${arch}`
  const dir = runtimeDir('java', id)
  return withLock(`runtime:${id}`, async () => {
    const home = homeOf(dir)
    if (!complete(home)) {
      log.line(`[runtime] Java ${asset.version.semver} (${os} ${arch})`)
      await fetchArchive({ url: asset.binary.package.link, dest: dir, checksum: { value: asset.binary.package.checksum }, strip: 1, log })
      if (!complete(home)) throw new Error(`Java runtime missing after extraction: ${binOf(home)}`)
      log.line(`[runtime] Java ready: ${home}`)
    }
    return { id, home, bin: binOf(home) }
  })
}
