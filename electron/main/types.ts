/** Product identity. The IPC bridge key `window.trymydev` mirrors this name in preload and renderer. */
export const PRODUCT = {
  name: 'TryMyDev',
  /** File a project may commit at its root to describe how it runs. */
  manifestFile: 'trymydev.json'
} as const

// ─── Manifest ─────────────────────────────────────────────────────────────────

export type Platform = 'windows' | 'macos' | 'linux'
export type Gpu = 'nvidia' | 'amd' | 'none'

/** Restricts a step or a start to some machines. Each field takes one value or a list. */
export interface Condition {
  platform?: Platform | Platform[]
  gpu?: Gpu | Gpu[]
}

/**
 * A step is a command line split on spaces, honouring quotes. No shell: no pipes,
 * no `&&`, no variable expansion — what is written is what is executed, on every
 * platform, without a shell to inject into.
 */
export interface Step {
  run: string
  /** Directory relative to the checkout. Defaults to the checkout itself. */
  cwd?: string
  /** Runs the step only on machines this matches; everywhere when absent. */
  when?: Condition
}

export type StartSpec =
  /** An Electron app: launched on a compatible Electron with its own user-data dir. */
  | { mode: 'electron' }
  /**
   * A server: started, then its address is opened. `{port}` in `run` or `url` becomes
   * a free port, searched from `port`; without it, `port` is where the server is awaited.
   */
  | { mode: 'web'; run: string; port?: number; url?: string }
  /** Anything else: started and left running, no window of our own. */
  | { mode: 'command'; run: string }
  /**
   * An Android application: its APK installed on a phone plugged in with USB debugging, else
   * on an emulator, then opened. A phone's screen is mirrored on the computer.
   */
  | {
      mode: 'android'
      /** The APK, or a folder searched for the newest one, relative to the checkout. */
      apk?: string
      /** The application id; read from the Gradle build when absent. */
      package?: string
      /** A GitHub Actions artifact holding the APK, taken instead of building when it exists for the commit. */
      artifact?: string
    }
  /**
   * An Expo project run in Expo Go, on Android or iPhone: its dev server is started and the
   * phone opens it from a QR code — or a connected Android device opens it directly.
   */
  | { mode: 'expo'; run: string; port?: number }

/** One of several starts: the first whose condition matches the machine is used. */
export type ConditionalStart = StartSpec & { when?: Condition }

/** A directory shared by every branch of the app instead of being duplicated. */
export interface ShareSpec {
  /** Path inside the checkout that becomes a link to the app-wide copy. */
  path: string
  /** Optional environment variable pointing at the shared directory. */
  env?: string
}

/** A directory a branch must NOT share with its siblings, redirected per branch. */
export interface IsolateSpec {
  env: string
  /** Sub-directory of the branch data folder the variable points at. */
  dir: string
}

/**
 * A file or link the application finds in its data folder when it starts: settings that
 * point at the right folders, a marker saying a setup screen was already done for it.
 * Strings may use {data}, {shared}, {venv}, {documents}, {appData}, {folder:<id>} and
 * {sha256:<checkout file>}.
 */
export interface SeedSpec {
  /** Path inside the branch data folder. */
  path: string
  /** JSON written there — once, keeping what the application changed, unless `always`. */
  json?: unknown
  /** Directory the path links to, placed again at every start. */
  link?: string
  always?: boolean
  /** The keys of `json` are set at every start; the rest of the file stays as the application left it. */
  merge?: boolean
}

/**
 * A folder of the application, per application, that is either TryMyDev's own or the one of an
 * installed copy of the application — or one the tester chose. Seeds use it as {folder:<id>}.
 */
export interface FolderSpec {
  id: string
  /** What the tester reads beside it. */
  label: string
  /** TryMyDev's folder for it, the same for every branch: starts with {shared} or {short}. */
  own: string
  /** An installed copy's folder: the path its settings file names, else where it usually is. */
  installed?: { file: string; key: string; usual: string }
  /** The one used until the tester switches; `installed` falls back to `own` when there is none. */
  use: 'own' | 'installed'
}

/** The tester's choice for a folder: one of the two, or a folder of their own. */
export type FolderChoice = 'own' | 'installed' | string

export interface Manifest {
  /** Display name of the application. */
  name: string
  /** Default repository, `owner/repo`. Branches may come from any fork of it. */
  repo?: string
  /** Runtimes the project needs; downloaded once and shared by every app. */
  runtime?: { node?: string; python?: string; java?: string; flutter?: string }
  install?: Step[]
  build?: Step[]
  start: StartSpec | ConditionalStart[]
  share?: ShareSpec[]
  isolate?: IsolateSpec[]
  seed?: SeedSpec[]
  folders?: FolderSpec[]
  env?: Record<string, string>
  /** Files whose hash decides when a cached environment must be rebuilt. */
  cacheKeys?: { node?: string[]; python?: string[] }
  /** Set by the loader, never written by hand. */
  source?: 'repository' | 'provided' | 'detected' | 'builtin'
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/** A manifest the user approved, for the code of one repository. */
export interface Approved {
  hash: string
  /** `owner/repo`, lowercase: whose code the approval trusts with these commands. */
  source: string
  /** The commands shown then, to point at what changed when the manifest does. */
  commands?: string[]
}

export interface App {
  id: string
  name: string
  /** Upstream repository, `owner/repo`: its forks and pull requests belong here. */
  repo?: string
  /** Manifest handed over by the developer, if any. The repository wins over it. */
  manifest?: Manifest
  approvals?: Approved[]
  /** Approvals recorded by earlier versions: bare hashes, valid for the upstream only. */
  approvedHashes?: string[]
  /** Folders the tester switched, by the id the manifest gives them. */
  folders?: Record<string, FolderChoice>
  addedAt: string
}

/** A branch, fork or pull request on GitHub. */
export interface GithubSource {
  kind: 'github'
  owner: string
  repo: string
  ref: string
  pr?: number
}

/** A branch of a clone on this computer: read with git, never pushed anywhere. */
export interface LocalSource {
  kind: 'local'
  /** Absolute path of the working tree's top level. */
  path: string
  /**
   * A branch's last commit. Without it, the folder as it is: whatever is checked out, with every
   * change and every file .gitignore does not exclude.
   */
  ref?: string
}

export type Source = GithubSource | LocalSource

export type Branch = Source & {
  key: string
  appId: string
  addedAt: string
}

export interface BranchState {
  sha?: string
  /** A local folder as it is: what it looked like when `sha` was read. */
  fingerprint?: string
  builtSha?: string
  /** Hash of the manifest used for the last successful build. */
  manifestHash?: string
  nodeKey?: string
  pythonKey?: string
  electronMajor?: string
  electronBinary?: string
  /** Address to open for a `web` start, remembered between runs; `exp://…` for an `expo` one. */
  url?: string
  /** The APK an `android` start installs, relative to the branch folder. */
  apk?: string
  /** The device an `android` start runs on, for the window. */
  device?: string
  lastCheck?: string
  lastLaunch?: string
  /** Milliseconds each phase took the last time sources were fetched or built, in `PHASES` order. */
  durations?: number[]
  /** A detached application left running, found again after TryMyDev restarts. */
  running?: { pid: number; image: string; startedAt?: number }
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export type JobStep =
  | 'resolve'
  | 'download'
  | 'manifest'
  | 'runtime'
  | 'install'
  | 'build'
  | 'launch'
  | 'running'
  | 'done'

/** What the tester sees of a start: each JobStep belongs to one of these. */
export const PHASES = ['Download', 'Install', 'Build', 'Start'] as const

export interface JobEvent {
  key: string
  step: JobStep
  message: string
  percent?: number
  /** When the current step began, for the elapsed time shown on the card. */
  since?: number
  /** Index in `PHASES`, and when that phase began. */
  phase: number
  phaseSince: number
  /** When the start began. */
  startedAt: number
  /** How long each phase took last time, for an estimate of what is left. */
  estimate?: number[]
}

export interface JobError {
  key: string
  step: JobStep
  /** Index in `PHASES` of the step that failed. */
  phase?: number
  message: string
  logTail: string
  logPath: string
  /** What the tester can do about it, for failures seen before. */
  hint?: string
}

/** Shown before a manifest runs for the first time, so nothing executes unseen. */
export interface Approval {
  appId: string
  appName: string
  /** `owner/repo` the code comes from, or the folder of a local clone. */
  repo: string
  /** The code is a clone on this computer. */
  local?: boolean
  /** `owner/repo` of the application, when known. */
  upstream?: string
  /** The code comes from another repository than the application's own. */
  foreign: boolean
  manifestHash: string
  source: Manifest['source']
  commands: string[]
  /** Links, per-branch redirections and environment variables the manifest sets up. */
  settings: string[]
  downloads: string[]
  /** What the sources will lack, such as submodules GitHub archives leave out. */
  warnings: string[]
  /** Commands absent from the last approval of this code, by index; only when there was one. */
  changed?: number[]
  /** For code from elsewhere than the official repository: what it changes in what runs at install. */
  install?: InstallReview
}

/** One install file a branch changes, against the official project's default branch. */
export interface InstallChange {
  file: string
  /** The official project has no such file. */
  added: boolean
  lines: string[]
}

export interface InstallReview {
  /** `owner/repo` compared with, at its default branch. */
  against: string
  changes: InstallChange[]
  /** Why the comparison could not be made. */
  unavailable?: string
}
