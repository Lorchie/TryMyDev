export interface BranchView {
  key: string
  appId: string
  kind: 'github' | 'local'
  /** `owner/repo`, or the folder of a local clone. */
  name: string
  owner?: string
  repo?: string
  path?: string
  /** The ref, or "working tree" for a local folder followed as it is. */
  ref: string
  pr?: number
  label: string
  builtSha?: string
  url?: string
  /** The Android device it runs on. */
  device?: string
  /** Running on Android: its bug report is written from this window. */
  reportable: boolean
  running: boolean
  busy: boolean
  addedAt: string
}

export interface AppView {
  id: string
  name: string
  repo?: string
  addedAt: string
  branches: BranchView[]
}

export interface JobEvent {
  key: string
  step: string
  message: string
  percent?: number
  since?: number
  /** Index in Download, Install, Build, Start, and when it began. */
  phase: number
  phaseSince: number
  startedAt: number
  /** How long each phase took last time, in milliseconds. */
  estimate?: number[]
}

export interface JobError {
  key: string
  step: string
  phase?: number
  message: string
  logTail: string
  logPath: string
  hint?: string
}

export interface Approval {
  appId: string
  appName: string
  repo: string
  local?: boolean
  upstream?: string
  foreign: boolean
  manifestHash: string
  source?: 'repository' | 'provided' | 'detected' | 'builtin'
  commands: string[]
  settings: string[]
  downloads: string[]
  warnings: string[]
  /** Commands absent from the last approval of this code, by index. */
  changed?: number[]
  /** A fork's install files against the official project's. */
  install?: {
    against: string
    changes: Array<{ file: string; added: boolean; lines: string[] }>
    unavailable?: string
  }
}

export interface UsageEntry {
  label: string
  path: string
  bytes: number
  orphan: boolean
  group: string
  appId?: string
  key?: string
}

export type Theme = 'system' | 'dark' | 'light'

export interface Settings {
  githubToken: boolean
  /** Unused data removed when TryMyDev starts. */
  autoCleanup: boolean
  /** The tools overlay on tested applications. */
  overlay: boolean
  /** An agent may drive the applications TryMyDev starts. */
  agent: boolean
  /** Why agent access, switched on, is not listening. */
  agentError?: string
  theme: Theme
}

/** A folder of an application: TryMyDev's own, the installed application's, or one the tester picked. */
export interface FolderView {
  id: string
  label: string
  path: string
  source: 'own' | 'installed' | 'custom'
  chosen: boolean
  /** The installed application's folder, when there is one to switch to. */
  installed?: string
}

export interface Api {
  platform: string
  list: () => Promise<AppView[]>
  addApp: (input: string, manifest?: string) => Promise<AppView[]>
  removeApp: (appId: string) => Promise<AppView[]>
  folders: (appId: string) => Promise<FolderView[]>
  chooseFolder: (appId: string, id: string) => Promise<FolderView[]>
  useFolder: (appId: string, id: string, which: 'own' | 'installed') => Promise<FolderView[]>
  addBranch: (appId: string, input: string) => Promise<AppView[]>
  /** A folder from the system's dialog, or null when the tester cancelled. */
  pickRepository: () => Promise<string | null>
  removeBranch: (key: string) => Promise<AppView[]>
  start: (key: string) => Promise<void>
  cancel: (key: string) => Promise<void>
  /** `automatic`: skipped without a GitHub token, whose anonymous checks count against 60 an hour. */
  refresh: (appId?: string, automatic?: boolean) => Promise<AppView[]>
  shortcut: (key: string) => Promise<string>
  /** A QR code of an Expo address, as an image. */
  qrImage: (text: string) => Promise<string>
  /** The bug report of a branch running on Android: prepared, previewed, saved. */
  reportStart: (key: string) => Promise<{ markdown: string; logs: string; screenshot?: string }>
  reportPreview: (key: string, description: string) => Promise<string>
  /** The file name saved, or null when the tester cancelled. */
  reportSave: (key: string, description: string, screenshot: boolean) => Promise<string | null>
  reportClose: (key: string) => Promise<void>
  approve: (appId: string, hash: string, key: string) => Promise<void>
  usage: () => Promise<UsageEntry[]>
  prune: () => Promise<number>
  getSettings: () => Promise<Settings>
  setGithubToken: (token: string | null) => Promise<Settings & { limit?: number }>
  setPreference: (name: 'autoCleanup' | 'overlay' | 'agent', value: boolean) => Promise<Settings>
  setTheme: (theme: Theme) => Promise<Settings>
  copyAgentCommand: () => Promise<void>
  renewAgentToken: () => Promise<void>
  openLogs: (appId: string, key: string) => Promise<void>
  openAppLog: () => Promise<string>
  reportError: (message: string) => Promise<void>
  showItem: (path: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  copy: (text: string) => Promise<void>
  onStep: (cb: (p: JobEvent) => void) => () => void
  onLog: (cb: (p: { key: string; line: string }) => void) => () => void
  onError: (cb: (p: JobError) => void) => () => void
  onApproval: (cb: (p: { key: string; approval: Approval }) => void) => () => void
  onUpdated: (cb: (p: { key: string }) => void) => () => void
  onRemote: (cb: (p: { key: string; remoteSha: string | null }) => void) => () => void
}

export interface OverlayAnchor {
  side: 'left' | 'right'
  y: number
}

/** The bridge of the overlay page, on top of a tested application. */
export interface OverlayApi {
  info: () => Promise<{ label: string; anchor: OverlayAnchor }>
  resize: (width: number, height: number, open: boolean) => void
  /** The view covers the window while the button moves; where it was, in the window. */
  drag: () => Promise<{ x: number; y: number }>
  drop: (x: number, y: number) => Promise<OverlayAnchor>
  report: {
    start: () => Promise<{ markdown: string; logs: string; screenshot?: string }>
    preview: (description: string) => Promise<string>
    /** The name of the saved file, or null when the tester cancelled. */
    save: (description: string, screenshot: boolean) => Promise<string | null>
    show: () => Promise<void>
    close: () => void
  }
}

declare global {
  interface Window {
    trymydev: Api
    overlay: OverlayApi
  }
}
