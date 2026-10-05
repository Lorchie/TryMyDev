import { app as electronApp, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell, type BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { homedir, hostname } from 'os'
import { basename, dirname, join } from 'path'
import QRCode from 'qrcode'
import { redactText } from '../overlay/redact'
import { reportArchive, reportFileName, reportMarkdown, type ReportData } from '../overlay/report'
import { AndroidDriver } from './android'
import { agentStatus, claudeCommand, syncAgent } from './agent'
import { appLog, errorText } from './applog'
import { manifestOfApp, refusedFolder, resolveFolders, type FolderView } from './folders'
import { rateLimit } from './github'
import * as jobs from './jobs'
import { validate } from './manifest'
import { appLogPath, logsDir } from './paths'
import { readState } from './provision'
import * as registry from './registry'
import { driver, isRunning } from './runner'
import { forgetBranchSession, openExternalSafely, samePlace } from './security'
import {
  agentToken,
  hasGithubToken,
  preferences,
  renewAgentToken,
  setGithubToken,
  setPreference,
  setTheme,
  theme,
  type Preferences,
  type Theme
} from './settings'
import { createShortcut } from './shortcut'
import { appFor, resolveInput } from './sources'
import { refLabel, sourceName } from './source-url'
import { prune, usage } from './storage'
import type { App, Branch, Manifest } from './types'

export type BranchView = Branch & {
  /** `owner/repo`, or the folder of a local clone. */
  name: string
  label: string
  builtSha?: string
  url?: string
  /** The Android device it runs on. */
  device?: string
  running: boolean
  busy: boolean
  /** Running on Android: its bug report is written from this window, the overlay being out of reach. */
  reportable: boolean
}

export interface AppView extends App {
  branches: BranchView[]
}

function branchView(branch: Branch): BranchView {
  const state = readState(branch.appId, branch.key)
  return {
    ...branch,
    name: sourceName(branch),
    ref: refLabel(branch),
    label: registry.label(branch),
    builtSha: state.builtSha,
    url: state.url,
    device: isRunning(branch.key) ? state.device : undefined,
    running: isRunning(branch.key),
    busy: jobs.busy(branch.key),
    reportable: driver(branch.key) instanceof AndroidDriver
  }
}

function view(): AppView[] {
  return registry.apps().map((app) => ({
    ...app,
    branches: registry.branches(app.id).map(branchView)
  }))
}

/** Deleting gigabytes takes a while: the list updates at once, the disk follows. */
function cleanUpLater(): void {
  void prune().catch((err) => appLog(`[storage] cleanup failed: ${errorText(err)}`))
}

/** `home` is the page of the TryMyDev window: the only one allowed to call. */
export function registerIpc(getWindow: () => BrowserWindow | null, home: string): void {
  /**
   * Every call must come from the TryMyDev page in the TryMyDev window — never from a page
   * of a tested application, nor from another page loaded in that window — and is logged
   * when it fails: the window only ever sees the message.
   */
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (event.sender.id !== getWindow()?.webContents.id || !samePlace(event.senderFrame?.url ?? '', home)) {
          throw new Error(`Refused ${channel}: the call does not come from the TryMyDev window.`)
        }
        return await fn(...(args as A))
      } catch (err) {
        appLog(`[ipc] ${channel} failed: ${errorText(err)}`)
        throw err
      }
    })
  }

  handle('apps:list', () => view())

  /**
   * One thing to paste: a URL, optionally with the manifest the developer handed
   * over. The application is keyed on the upstream repository, so a fork lands
   * under the same entry instead of creating a second one.
   */
  handle('apps:add', async (input: string, manifestText?: string) => {
    let manifest: Manifest | undefined
    if (manifestText && manifestText.trim() !== '') {
      manifest = validate(manifestText, 'the manifest you pasted')
    }

    const resolved = await resolveInput(input)
    registry.addBranch(appFor(resolved, manifest).id, resolved.source)
    return view()
  })

  // A local clone, picked with the system's folder dialog; git says later whether it is one.
  handle('dialog:pickRepository', async () => {
    const win = getWindow()
    const options = { title: 'Local Git repository', properties: ['openDirectory'] as Array<'openDirectory'> }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })

  handle('apps:remove', (appId: string) => {
    for (const branch of registry.branches(appId)) {
      jobs.cancel(branch.key)
      forgetBranchSession(branch.key)
    }
    registry.removeApp(appId)
    cleanUpLater()
    return view()
  })

  // An application's folders. A chosen one comes from the system's folder picker, never from
  // the window; it applies the next time a branch starts.
  const folders = async (appId: string): Promise<FolderView[]> => {
    const app = registry.getApp(appId)
    const manifest = manifestOfApp(app)
    return manifest ? resolveFolders(app, manifest) : []
  }
  handle('apps:folders', (appId: string) => folders(appId))
  handle('apps:chooseFolder', async (appId: string, id: string) => {
    const current = (await folders(appId)).find((folder) => folder.id === id)
    if (!current) throw new Error(`Refused: ${appId} has no folder ${id}.`)
    const win = getWindow()
    const options = {
      title: `${current.label} folder`,
      defaultPath: current.path,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const chosen = picked.canceled ? undefined : picked.filePaths[0]
    if (chosen) {
      const refused = refusedFolder(chosen)
      if (refused) throw new Error(refused)
      registry.setFolder(appId, id, chosen)
    }
    return folders(appId)
  })
  // TryMyDev's folder or the installed application's: the paths are found again here, the
  // window only says which. The manifest's own choice is stored as no choice at all.
  handle('apps:useFolder', async (appId: string, id: string, which: 'own' | 'installed') => {
    const app = registry.getApp(appId)
    const spec = manifestOfApp(app)?.folders?.find((folder) => folder.id === id)
    if (!spec) throw new Error(`Refused: ${appId} has no folder ${id}.`)
    if (which !== 'own' && which !== 'installed') throw new Error(`Refused: no folder "${String(which)}".`)
    if (which === 'installed' && !(await folders(appId)).find((folder) => folder.id === id)?.installed) {
      throw new Error(`Refused: ${app.name} is not installed on this computer, or keeps no ${spec.label} folder.`)
    }
    registry.setFolder(appId, id, which === spec.use ? undefined : which)
    return folders(appId)
  })

  handle('branches:add', async (appId: string, input: string) => {
    const { source } = await resolveInput(input)
    registry.addBranch(appId, source)
    return view()
  })

  handle('branches:remove', (key: string) => {
    jobs.cancel(key)
    forgetBranchSession(key)
    registry.removeBranch(key)
    cleanUpLater()
    return view()
  })

  handle('branches:start', async (key: string) => {
    const win = getWindow()
    if (win) await jobs.startBranch(win, key)
  })

  handle('branches:cancel', (key: string) => jobs.cancel(key))

  // Anonymous, even a 304 counts against GitHub's 60 calls an hour: without a token, GitHub
  // branches are checked when the tester asks, one application at a time. Local clones are free.
  handle('branches:refresh', async (appId?: string, automatic?: boolean) => {
    const win = getWindow()
    if (win) {
      const list = registry.branches(typeof appId === 'string' ? appId : undefined)
      await jobs.refresh(win, automatic === true ? jobs.checkedFreely(list) : list)
    }
    return view()
  })

  // Expo Go opens the dev server from a QR code; only its addresses are drawn.
  handle('qr:image', (text: string) => {
    if (typeof text !== 'string' || !/^exp:\/\/[\w.-]+:\d+$/.test(text)) throw new Error('Refused: not an Expo address.')
    return QRCode.toDataURL(text, { margin: 1, width: 240 })
  })

  // A report of an application on Android: prepared once, previewed as the tester describes, saved where they choose.
  const reports = new Map<string, { data: ReportData; screenshot?: Buffer }>()
  const android = (key: string): AndroidDriver => {
    const found = driver(key)
    if (!(found instanceof AndroidDriver)) throw new Error('This branch is not running on Android.')
    return found
  }
  const described = (data: ReportData, description: unknown): string =>
    typeof description === 'string' ? redactText(description.slice(0, 10_000), { home: homedir(), hostname: hostname() }) : ''

  handle('report:start', async (key: string) => {
    const d = android(key)
    const data = await d.reportData()
    const screenshot = await d.capture().catch(() => undefined)
    reports.set(key, { data, screenshot })
    const image = screenshot ? nativeImage.createFromBuffer(screenshot) : undefined
    return {
      markdown: reportMarkdown(data, ''),
      logs: data.log.join('\n'),
      screenshot: image && !image.isEmpty() ? image.resize({ width: 240 }).toDataURL() : undefined
    }
  })

  handle('report:preview', (key: string, description: string) => {
    const report = reports.get(key)
    return report ? reportMarkdown(report.data, described(report.data, description)) : ''
  })

  handle('report:save', async (key: string, description: string, withScreenshot: boolean) => {
    const report = reports.get(key)
    const win = getWindow()
    if (!report || !win) return null
    let folder: string
    try {
      folder = electronApp.getPath('desktop')
    } catch {
      folder = homedir()
    }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save the bug report',
      defaultPath: join(folder, reportFileName(report.data.label, report.data.at)),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, reportArchive(report.data, described(report.data, description), withScreenshot === false ? undefined : report.screenshot))
    reports.delete(key)
    shell.showItemInFolder(filePath)
    return basename(filePath)
  })

  handle('report:close', (key: string) => {
    reports.delete(key)
  })

  handle('branches:shortcut', (key: string) => {
    const branch = registry.getBranch(key)
    return createShortcut(registry.getApp(branch.appId), branch)
  })

  /**
   * The tester accepted the commands they were shown; run them. The approval is for the
   * code of the branch's own repository, read here — never taken from the window.
   */
  handle('manifest:approve', async (appId: string, hash: string, key: string) => {
    const branch = registry.getBranch(key)
    if (branch.appId !== appId) throw new Error(`Refused: ${key} is not a branch of ${appId}.`)
    const shown = jobs.pendingApproval(key)
    registry.approveApp(branch.appId, hash, branch, shown?.manifestHash === hash ? shown.commands : undefined)
    const win = getWindow()
    if (win) await jobs.startBranch(win, key)
  })

  handle('storage:usage', () => usage())
  // Download caches only go while nothing is installing from them.
  handle('storage:prune', () => prune({ caches: !jobs.installing() }))

  const settings = (): Record<string, unknown> => {
    const { error } = agentStatus()
    return { githubToken: hasGithubToken(), ...preferences(), theme: theme(), ...(error ? { agentError: error } : {}) }
  }
  handle('settings:get', () => settings())
  handle('settings:setGithubToken', async (token: string | null) => {
    if (!token?.trim()) {
      setGithubToken(undefined)
      return settings()
    }
    const limit = await rateLimit(token.trim())
    setGithubToken(token)
    return { ...settings(), limit }
  })
  handle('settings:setPreference', async (name: keyof Preferences, value: boolean) => {
    setPreference(name, value)
    if (name === 'agent') await syncAgent(value, getWindow)
    return settings()
  })
  handle('settings:setTheme', (value: Theme) => {
    nativeTheme.themeSource = setTheme(value)
    return settings()
  })
  // The token goes from here to the clipboard: the window never holds it.
  handle('settings:copyAgentCommand', () => {
    const token = agentToken()
    if (!token) throw new Error('Agent access is off: switch it on first.')
    clipboard.writeText(claudeCommand(token))
  })
  handle('settings:renewAgentToken', () => {
    clipboard.writeText(claudeCommand(renewAgentToken()))
  })

  // The folder is found from the registry, never built from what the window sends.
  handle('branches:openLogs', (_appId: string, key: string) => {
    const branch = registry.getBranch(key)
    return shell.openPath(logsDir(branch.appId, branch.key))
  })
  handle('app:openLog', () => {
    const path = appLogPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, '')
    return shell.openPath(path)
  })
  handle('app:reportError', (message: string) => appLog(`[window] ${message}`))
  // The window is sandboxed: the clipboard is reached through here.
  handle('app:copy', (text: string) => clipboard.writeText(text))
  handle('shell:showItem', (path: string) => shell.showItemInFolder(path))
  handle('shell:openExternal', (url: string) => openExternalSafely(url))
}
