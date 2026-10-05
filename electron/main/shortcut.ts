import { app, shell } from 'electron'
import { join } from 'path'
import { refLabel, sourceAddress, sourceName } from './source-url'
import type { App, Branch } from './types'

/**
 * A desktop shortcut that opens one branch directly, for the tester who follows it.
 * Windows only: Electron has no shortcut API elsewhere.
 */
export function createShortcut(application: App, branch: Branch): string {
  if (process.platform !== 'win32') throw new Error('Desktop shortcuts are only available on Windows.')

  const name = `${application.name} - ${refLabel(branch)}`.replace(/[<>:"/\\|?*]+/g, '-')
  const path = join(app.getPath('desktop'), `${name}.lnk`)
  // A folder may hold spaces.
  const address = sourceAddress(branch)
  const start = /\s/.test(address) ? `"--start=${address}"` : `--start=${address}`
  // Unpackaged, the Electron binary needs the application folder before its arguments.
  const args = app.isPackaged ? start : `"${app.getAppPath()}" ${start}`

  const written = shell.writeShortcutLink(path, 'create', {
    target: process.execPath,
    args,
    description: `${application.name} · ${sourceName(branch)} · ${refLabel(branch)}`,
    icon: process.execPath,
    iconIndex: 0
  })
  if (!written) throw new Error(`Could not create the shortcut ${path}.`)
  return path
}
