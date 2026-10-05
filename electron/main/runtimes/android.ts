import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { withLock } from '../lock'
import { request } from '../network'
import { androidAvdDir, androidSdkDir, androidUserDir } from '../paths'
import { spawnTool, type RunContext, type Toolchain } from '../proc'
import { fetchArchive } from './download'
import type { BranchLog } from '../logger'

/**
 * The Android SDK, from Google's own repository index: platform-tools (adb) for a phone, the
 * command-line tools to add what Gradle and the emulator need. Since version 23 the tools are
 * the Android CLI (`android sdk install`), which shows the licence on its first run and records
 * it when it installs a package; sdkmanager only forwards to it. Gradle fetches the build tools
 * a project names by itself once that record exists — it refuses to otherwise.
 */

const REPOSITORY = 'https://dl.google.com/android/repository/'
export const LICENCE_URL = 'https://developer.android.com/studio/terms'
const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)
const script = (name: string): string => (process.platform === 'win32' ? `${name}.bat` : name)

export interface RepoArchive {
  url: string
  sha1: string
  size: number
  revision: string
}

function hostOs(): string {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macosx' : 'linux'
}

function hostArch(): string {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

/**
 * One package of the index: its stable channel, for this system. An archive naming no host is
 * the same everywhere; one naming an architecture is only for it.
 */
export function repositoryArchive(xml: string, path: string, os = hostOs(), arch = hostArch()): RepoArchive | undefined {
  const packages = [...xml.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)]
    .filter((m) => m[1] === path)
    .map((m) => m[2])
  const stable = packages.find((body) => /<channelRef ref="channel-0"\s*\/>/.test(body)) ?? packages[0]
  if (!stable) return undefined
  const revision = ['major', 'minor', 'micro']
    .map((part) => stable.match(new RegExp(`<revision>[\\s\\S]*?<${part}>(\\d+)</${part}>`))?.[1])
    .filter(Boolean)
    .join('.')
  for (const [, archive] of stable.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
    const archiveOs = archive.match(/<host-os>([^<]+)<\/host-os>/)?.[1]
    const archiveArch = archive.match(/<host-arch>([^<]+)<\/host-arch>/)?.[1]
    if (archiveOs && archiveOs !== os) continue
    if (archiveArch && archiveArch !== arch) continue
    const sha1 = archive.match(/<checksum type="sha1">([0-9a-f]{40})<\/checksum>/)?.[1]
    const url = archive.match(/<url>([^<]+)<\/url>/)?.[1]
    const size = Number(archive.match(/<size>(\d+)<\/size>/)?.[1] ?? 0)
    if (sha1 && url) return { url: new URL(url, REPOSITORY).href, sha1, size, revision }
  }
  return undefined
}

async function repositoryIndex(): Promise<string> {
  const res = await request(`${REPOSITORY}repository2-3.xml`)
  if (!res.ok) throw new Error(`Could not read Google's Android repository (HTTP ${res.status}).`)
  return res.text()
}

async function fetchPackage(path: string, dest: string, log: BranchLog): Promise<void> {
  const archive = repositoryArchive(await repositoryIndex(), path)
  if (!archive) throw new Error(`Google's Android repository has no "${path}" for this system.`)
  log.line(`[runtime] Android ${path} ${archive.revision}`)
  await fetchArchive({ url: archive.url, dest, checksum: { value: archive.sha1, algorithm: 'sha1' }, strip: 1, log })
}

export const adbPath = (sdk = androidSdkDir()): string => join(sdk, 'platform-tools', exe('adb'))
export const emulatorPath = (sdk = androidSdkDir()): string => join(sdk, 'emulator', exe('emulator'))
const sdkmanagerPath = (sdk: string): string => join(sdk, 'cmdline-tools', 'latest', 'bin', script('sdkmanager'))
/** The Android CLI of command-line tools 23 and later; earlier ones have sdkmanager alone. */
const cliPath = (sdk: string): string => join(sdk, 'cmdline-tools', 'latest', 'bin', exe('android'))
const licencePath = (sdk: string): string => join(sdk, 'licenses', 'android-sdk-license')
const avdmanagerPath = (sdk: string): string => join(sdk, 'cmdline-tools', 'latest', 'bin', script('avdmanager'))

/** adb alone — 10 MB, no Java: enough to install and open an APK on a phone. */
export async function ensurePlatformTools(log: BranchLog): Promise<string> {
  if (existsSync(adbPath())) return adbPath()
  return withLock('android-sdk', async () => {
    if (!existsSync(adbPath())) await fetchPackage('platform-tools', join(androidSdkDir(), 'platform-tools'), log)
    return adbPath()
  })
}

/** The SDK as Gradle needs it: adb, the command-line tools, and the licence the tester accepted. */
export function cachedAndroidSdk(): string | undefined {
  const sdk = androidSdkDir()
  return existsSync(sdkmanagerPath(sdk)) && existsSync(adbPath(sdk)) && existsSync(licencePath(sdk)) ? sdk : undefined
}

/**
 * Accepting the licence is the tester's act: the approval they gave lists it, with its address.
 * The first package installed records it — the platform the project compiles against, which
 * Gradle would fetch anyway; older tools ask once per licence instead, and each answer is yes.
 */
export async function ensureAndroidSdk(toolchain: Toolchain, log: BranchLog, platform = DEFAULT_PLATFORM): Promise<string> {
  const cached = cachedAndroidSdk()
  if (cached) return cached
  await ensurePlatformTools(log)
  return withLock('android-sdk', async () => {
    const sdk = androidSdkDir()
    if (!existsSync(sdkmanagerPath(sdk))) await fetchPackage('cmdline-tools;latest', join(sdk, 'cmdline-tools', 'latest'), log)
    if (!existsSync(licencePath(sdk))) {
      log.line(`[runtime] accepting the Android SDK licence, as approved (${LICENCE_URL})`)
      if (existsSync(cliPath(sdk))) await sdkInstall([platform], toolchain, log)
      else await sdkmanager(['--licenses'], toolchain, log, 'y\n'.repeat(30))
    }
    if (!existsSync(licencePath(sdk))) throw new Error('The Android SDK licence could not be accepted.')
    return sdk
  })
}

/** What a project compiles against, when its build does not say it plainly (Flutter's does not). */
export const DEFAULT_PLATFORM = 'platforms;android-35'

/** `compileSdk 35`, `compileSdk = 35`, `compileSdkVersion 34` in the application's Gradle build. */
export function platformOf(gradle: string): string | undefined {
  const level = gradle.match(/compileSdk(?:Version)?\s*(?:=\s*)?\(?\s*(\d{2,})/)?.[1]
  return level ? `platforms;android-${level}` : undefined
}

/** Packages added to the SDK: through the Android CLI when there is one, never sending usage data. */
function sdkInstall(packages: string[], toolchain: Toolchain, log: BranchLog): Promise<void> {
  const sdk = androidSdkDir()
  if (!existsSync(cliPath(sdk))) return sdkmanager(packages, toolchain, log, 'y\n'.repeat(10))
  return tool(cliPath(sdk), ['--no-metrics', `--sdk=${sdk}`, 'sdk', 'install', ...packages], toolchain, log)
}

/** sdkmanager reads Java's proxy settings, never HTTPS_PROXY: the system's proxy is given to it. */
function proxyArgs(proxy: string | undefined): string[] {
  if (!proxy) return []
  try {
    const url = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
    return [`--proxy=http`, `--proxy_host=${url.hostname}`, `--proxy_port=${url.port || '80'}`]
  } catch {
    return []
  }
}

function tool(file: string, args: string[], toolchain: Toolchain, log: BranchLog, input?: string): Promise<void> {
  const ctx: RunContext = { toolchain: { ...toolchain, androidSdk: androidSdkDir() }, cwd: androidSdkDir(), log, input }
  return new Promise((resolve, reject) => {
    log.line(`$ ${file} ${args.join(' ')}`)
    const child = spawnTool(file, args, ctx)
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed (exit code ${code}): ${file} ${args.join(' ')}\n${log.getTail(15)}`))
    )
  })
}

function sdkmanager(args: string[], toolchain: Toolchain, log: BranchLog, input?: string): Promise<void> {
  const sdk = androidSdkDir()
  return tool(sdkmanagerPath(sdk), [`--sdk_root=${sdk}`, ...proxyArgs(toolchain.proxy), ...args], toolchain, log, input)
}

export const AVD_NAME = 'TryMyDev'

/** A recent Android with Google APIs, for the processor of this computer. */
export function systemImage(): string {
  return `system-images;android-35;google_apis;${process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64'}`
}

/** The emulator, a system image and one virtual phone, shared by every application. */
export async function ensureEmulator(toolchain: Toolchain, log: BranchLog): Promise<string> {
  const sdk = await ensureAndroidSdk(toolchain, log)
  const avd = join(androidAvdDir(), `${AVD_NAME}.ini`)
  if (existsSync(emulatorPath(sdk)) && existsSync(avd)) return emulatorPath(sdk)
  return withLock('android-sdk', async () => {
    if (!existsSync(emulatorPath(sdk)) || !existsSync(join(sdk, ...systemImage().split(';')))) {
      log.line('[runtime] Android emulator and system image (~2 GB, once)')
      await sdkInstall(['emulator', systemImage()], toolchain, log)
    }
    if (!existsSync(avd)) {
      await mkdir(androidAvdDir(), { recursive: true })
      await mkdir(androidUserDir(), { recursive: true })
      // "Do you wish to create a custom hardware profile?" — no.
      await tool(
        avdmanagerPath(sdk),
        ['create', 'avd', '--name', AVD_NAME, '--package', systemImage(), '--device', 'pixel_6', '--force'],
        toolchain,
        log,
        'no\n'
      )
    }
    if (!existsSync(emulatorPath(sdk))) throw new Error(`The Android emulator is missing after its installation: ${emulatorPath(sdk)}`)
    return emulatorPath(sdk)
  })
}
