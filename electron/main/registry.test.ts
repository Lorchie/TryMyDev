import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { writeJson } from './fsx'
import { branchDir, registryBackupPath, registryPath } from './paths'
import * as registry from './registry'
import { branchKey } from './source-url'
import { cleanup, useUserData } from './testing'
import type { Manifest } from './types'

let data: string
before(() => {
  data = useUserData()
})
after(() => cleanup(data))
beforeEach(() => writeJson(registryPath(), { apps: [], branches: [] }))

const manifest: Manifest = { name: 'My App', start: { mode: 'command', run: 'x' } }
const upstream = { kind: 'github' as const, owner: 'o', repo: 'r', ref: 'main' }

describe('registry', () => {
  it('keys an application on its upstream repository', () => {
    const app = registry.addApp('Comfy-Org/ComfyUI')
    assert.equal(app.id, 'comfy-org-comfyui')
    assert.equal(app.name, 'ComfyUI')
    assert.equal(app.repo, 'Comfy-Org/ComfyUI')
    assert.deepEqual(registry.apps().map((a) => a.id), ['comfy-org-comfyui'])
  })

  it('names an application after the manifest pasted with it', () => {
    assert.equal(registry.addApp('o/r', manifest).name, 'My App')
  })

  it('adds an application once, taking a newer manifest but keeping its approvals', () => {
    const first = registry.addApp('o/r')
    registry.approveApp(first.id, 'hash-1', upstream)
    const again = registry.addApp('O/R', { ...manifest, name: 'Newer' })

    assert.equal(registry.apps().length, 1)
    assert.equal(again.manifest?.name, 'Newer')
    assert.deepEqual(registry.getApp(first.id).approvals, [{ hash: 'hash-1', source: 'o/r' }])
  })

  it("remembers the tester's folder for an application, and forgets it on reset", () => {
    const app = registry.addApp('o/r')
    registry.setFolder(app.id, 'extensions', 'D:\\Modly\\extensions')
    registry.setFolder(app.id, 'presets', 'D:\\presets')
    assert.deepEqual(registry.getApp(app.id).folders, { extensions: 'D:\\Modly\\extensions', presets: 'D:\\presets' })

    registry.setFolder(app.id, 'extensions', undefined)
    registry.setFolder(app.id, 'presets', undefined)
    assert.equal(registry.getApp(app.id).folders, undefined)
    assert.throws(() => registry.setFolder('nope', 'extensions', 'x'), /Unknown application: nope/)
  })

  it('fills in the repository of an application registered before it was recorded', () => {
    writeJson(registryPath(), { apps: [{ id: 'lightningpixel-modly', name: 'Modly', addedAt: '' }], branches: [] })
    registry.addApp('lightningpixel/modly')
    assert.equal(registry.getApp('lightningpixel-modly').repo, 'lightningpixel/modly')
  })

  it('records each approval once per repository, and ignores an unknown application', () => {
    const app = registry.addApp('o/r')
    registry.approveApp(app.id, 'h1', upstream)
    registry.approveApp(app.id, 'h1', { ...upstream, ref: 'other', owner: 'O' })
    registry.approveApp(app.id, 'h1', { kind: 'github' as const, owner: 'fork', repo: 'r', ref: 'main' })
    registry.approveApp('nope', 'h3', upstream)
    assert.deepEqual(registry.getApp(app.id).approvals, [
      { hash: 'h1', source: 'o/r' },
      { hash: 'h1', source: 'fork/r' }
    ])
  })

  it('adds a branch once under a short key, whatever case the address uses', () => {
    const app = registry.addApp('o/r')
    const a = registry.addBranch(app.id, { kind: 'github' as const, owner: 'Fork', repo: 'R', ref: 'dev' })
    const b = registry.addBranch(app.id, { kind: 'github' as const, owner: 'fork', repo: 'r', ref: 'dev' })
    assert.match(a.key, /^dev-[0-9a-f]{8}$/)
    assert.equal(b.key, a.key)
    assert.equal(registry.branches().length, 1)

    registry.addBranch(app.id, { kind: 'github' as const, owner: 'fork', repo: 'r', ref: 'Dev' })
    assert.equal(registry.branches().length, 2, 'refs are case-sensitive')
    assert.equal(registry.branches('other').length, 0)
  })

  it('finds a branch registered under an older key instead of adding it twice', () => {
    writeJson(registryPath(), {
      apps: [{ id: 'o-r', name: 'r', repo: 'o/r', addedAt: '' }],
      branches: [{ key: 'o-r__o__r__dev', appId: 'o-r', owner: 'o', repo: 'r', ref: 'dev', addedAt: '' }]
    })
    assert.equal(registry.addBranch('o-r', { kind: 'github' as const, owner: 'o', repo: 'r', ref: 'dev' }).key, 'o-r__o__r__dev')
    assert.equal(registry.branches().length, 1)
  })

  it('removes a branch, or an application with its branches and nothing else', () => {
    const one = registry.addApp('o/one')
    const two = registry.addApp('o/two')
    const kept = registry.addBranch(two.id, { kind: 'github' as const, owner: 'o', repo: 'two', ref: 'main' })
    const dropped = registry.addBranch(one.id, { kind: 'github' as const, owner: 'o', repo: 'one', ref: 'dev' })
    registry.addBranch(one.id, { kind: 'github' as const, owner: 'o', repo: 'one', ref: 'main' })

    registry.removeBranch(dropped.key)
    assert.equal(registry.branches(one.id).length, 1)

    registry.removeApp(one.id)
    assert.deepEqual(registry.apps().map((a) => a.id), [two.id])
    assert.deepEqual(registry.branches().map((b) => b.key), [kept.key])
  })

  it('refuses to take an unreadable registry for an empty one, and leaves it untouched', () => {
    for (const content of ['', '{"apps": [{"id": "o-r"', '{"something": "else"}']) {
      writeFileSync(registryPath(), content)
      assert.throws(() => registry.apps(), /registry\.json is unreadable/)
      assert.throws(() => registry.addApp('o/new'), /registry\.json is unreadable/)
      assert.equal(readFileSync(registryPath(), 'utf-8'), content)
    }
    rmSync(registryPath())
    assert.deepEqual(registry.apps(), [], 'no registry yet is an empty one')
  })

  it('keeps the previous registry before each change, and puts it back in place of an unreadable one', () => {
    rmSync(registryBackupPath(), { force: true })
    registry.addApp('o/first')
    registry.addApp('o/second')
    const backup = JSON.parse(readFileSync(registryBackupPath(), 'utf-8')) as { apps: { id: string }[] }
    assert.deepEqual(backup.apps.map((a) => a.id), ['o-first'])

    writeFileSync(registryPath(), '{ torn by a crash')
    assert.match(registry.problem()?.message ?? '', /unreadable .*TryMyDev offers its previous version/)
    assert.equal(registry.backupReadable(), true)

    const broken = registry.restoreBackup()
    assert.equal(readFileSync(broken, 'utf-8'), '{ torn by a crash', 'the unreadable file is kept')
    assert.deepEqual(registry.apps().map((a) => a.id), ['o-first'])
    assert.equal(registry.problem(), undefined)
  })

  it('offers no backup it could not read', () => {
    writeFileSync(registryBackupPath(), 'nope')
    assert.equal(registry.backupReadable(), false)
    rmSync(registryBackupPath())
    assert.equal(registry.backupReadable(), false)
  })

  it('never names an application folder "." or ".."', () => {
    assert.throws(() => registry.addApp('-/..'), /Not a repository/)
  })

  it('names what it cannot find', () => {
    assert.throws(() => registry.getApp('nope'), /Unknown application: nope/)
    assert.throws(() => registry.getBranch('nope'), /Unknown branch: nope/)
  })

  it('labels a branch, and a pull request as such', () => {
    const branch = { key: 'k', appId: 'a', kind: 'github' as const, owner: 'fork', repo: 'r', ref: 'dev', addedAt: '' }
    assert.equal(registry.label(branch), 'fork/r · dev')
    assert.equal(registry.label({ ...branch, pr: 42 }), 'fork/r · dev (PR #42)')
  })
})

describe('isApproved', () => {
  const modly = { kind: 'github' as const, owner: 'lightningpixel', repo: 'modly', ref: 'dev' }
  const stranger = { kind: 'github' as const, owner: 'stranger', repo: 'modly', ref: 'evil' }

  it('trusts a manifest only for the code of the repository it was approved for', () => {
    const app = registry.addApp('lightningpixel/modly')
    registry.approveApp(app.id, 'h', modly)
    const saved = registry.getApp(app.id)

    assert.equal(registry.isApproved(saved, 'h', { ...modly, ref: 'another-branch' }), true)
    assert.equal(registry.isApproved(saved, 'h', { ...modly, owner: 'LightningPixel' }), true)
    assert.equal(registry.isApproved(saved, 'h', stranger), false, "a stranger's fork asks again")
    assert.equal(registry.isApproved(saved, 'other', modly), false)
  })

  it('keeps the commands an approval was given for, per repository', () => {
    const app = registry.addApp('owner/shown')
    const upstream = { kind: 'github' as const, owner: 'owner', repo: 'shown', ref: 'main' }
    assert.equal(registry.approvedCommands(app, upstream), undefined)

    registry.approveApp(app.id, 'h1', upstream, ['npm ci', 'npm start'])
    registry.approveApp(app.id, 'h2', upstream, ['npm ci', 'npm run dev'])
    registry.approveApp(app.id, 'h3', { ...upstream, owner: 'fork' }, ['curl evil'])
    const saved = registry.getApp(app.id)

    assert.deepEqual(registry.approvedCommands(saved, { ...upstream, ref: 'dev' }), ['npm ci', 'npm run dev'])
    assert.deepEqual(registry.approvedCommands(saved, { ...upstream, owner: 'fork' }), ['curl evil'])
  })

  it('reads the approvals of earlier versions as given for the upstream repository only', () => {
    const legacy = { id: 'lightningpixel-modly', name: 'Modly', repo: 'lightningpixel/modly', approvedHashes: ['h'], addedAt: '' }
    assert.equal(registry.isApproved(legacy, 'h', modly), true)
    assert.equal(registry.isApproved(legacy, 'h', stranger), false)
    assert.equal(registry.isApproved({ ...legacy, repo: undefined }, 'h', modly), false)
  })
})

describe('migrateKeys', () => {
  it('moves branch folders from their old long keys to short ones', async () => {
    const old = 'lightningpixel-modly__lightningpixel__modly__dev'
    writeJson(registryPath(), {
      apps: [{ id: 'lightningpixel-modly', name: 'Modly', addedAt: '' }],
      branches: [
        { key: old, appId: 'lightningpixel-modly', owner: 'lightningpixel', repo: 'modly', ref: 'dev', addedAt: '' },
        { key: 'lightningpixel-modly__o__r__x', appId: 'lightningpixel-modly', owner: 'o', repo: 'r', ref: 'x', addedAt: '' }
      ]
    })
    mkdirSync(join(branchDir('lightningpixel-modly', old), 'checkout'), { recursive: true })
    writeFileSync(join(branchDir('lightningpixel-modly', old), 'checkout', 'main.js'), 'x')

    assert.equal(await registry.migrateKeys(), 2)
    const [modly, other] = registry.branches()
    assert.equal(modly.key, branchKey('lightningpixel-modly', modly))
    assert.ok(existsSync(join(branchDir('lightningpixel-modly', modly.key), 'checkout', 'main.js')))
    assert.equal(existsSync(branchDir('lightningpixel-modly', old)), false)
    assert.equal(other.key, branchKey('lightningpixel-modly', other), 'a branch without a folder takes its new key')
    assert.equal(await registry.migrateKeys(), 0)
  })

  it('leaves a branch whose folder cannot move, for a later start', async () => {
    const old = 'o-r__o__r__main'
    writeJson(registryPath(), {
      apps: [{ id: 'o-r', name: 'r', addedAt: '' }],
      branches: [{ key: old, appId: 'o-r', owner: 'o', repo: 'r', ref: 'main', addedAt: '' }]
    })
    const target = branchDir('o-r', branchKey('o-r', { kind: 'github' as const, owner: 'o', repo: 'r', ref: 'main' }))
    mkdirSync(branchDir('o-r', old), { recursive: true })
    writeFileSync(join(branchDir('o-r', old), 'a.txt'), '1')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'b.txt'), '1')

    const held: string[] = []
    assert.equal(await registry.migrateKeys((folder, err) => held.push(`${folder}:${err.code}`)), 0)
    assert.equal(registry.branches()[0].key, old)
    assert.equal(held.length, 1)
    assert.match(held[0], /o-r__o__r__main:E[A-Z]+$/, 'the reason is reported')
  })
})

describe('registry, local clones', () => {
  const clone = { kind: 'local' as const, path: process.platform === 'win32' ? 'C:\\code\\Modly' : '/code/Modly', ref: 'dev' }

  it('reads branches recorded before local clones as GitHub branches, under the same key', () => {
    const key = branchKey('o-r', { kind: 'github', owner: 'o', repo: 'r', ref: 'main' })
    writeJson(registryPath(), {
      apps: [{ id: 'o-r', name: 'r', repo: 'o/r', addedAt: '' }],
      branches: [{ key, appId: 'o-r', owner: 'o', repo: 'r', ref: 'main', addedAt: '' }]
    })
    const [branch] = registry.branches()
    assert.equal(branch.kind, 'github')
    assert.equal(branch.key, key)
    assert.equal(registry.addBranch('o-r', { kind: 'github', owner: 'o', repo: 'r', ref: 'main' }).key, key)
    assert.equal(registry.branches().length, 1)
  })

  it('gives a clone with no GitHub remote an application of its own, without a repository', () => {
    const app = registry.addLocalApp(clone.path, 'Modly')
    assert.match(app.id, /^modly-[0-9a-f]{6}$/)
    assert.equal(app.name, 'Modly')
    assert.equal(app.repo, undefined)
    assert.equal(registry.addLocalApp(clone.path, 'Modly').id, app.id)
    assert.notEqual(registry.addLocalApp(`${clone.path}2`, 'Modly').id, app.id)
  })

  it('adds a clone once, as it is or by branch', () => {
    const app = registry.addApp('lightningpixel/modly')
    const first = registry.addBranch(app.id, clone)
    assert.equal(registry.addBranch(app.id, { ...clone }).key, first.key)
    const { ref: _ref, ...folder } = clone
    assert.notEqual(registry.addBranch(app.id, folder).key, first.key)
    assert.notEqual(registry.addBranch(app.id, { kind: 'github', owner: 'lightningpixel', repo: 'modly', ref: 'dev' }).key, first.key)
    assert.equal(registry.branches(app.id).length, 3)
  })

  it('never lets an approval of the GitHub repository run a clone, nor the reverse', () => {
    const app = registry.addApp('lightningpixel/modly')
    const github = { kind: 'github' as const, owner: 'lightningpixel', repo: 'modly', ref: 'dev' }
    registry.approveApp(app.id, 'h', github)
    assert.equal(registry.isApproved(registry.getApp(app.id), 'h', clone), false)

    registry.approveApp(app.id, 'h2', clone)
    const approved = registry.getApp(app.id)
    assert.equal(registry.isApproved(approved, 'h2', clone), true)
    assert.equal(registry.isApproved(approved, 'h2', { kind: 'local', path: clone.path }), true, 'the folder as it is, other branches')
    assert.equal(registry.isApproved(approved, 'h2', github), false)
    assert.equal(registry.isApproved(approved, 'h2', { ...clone, path: `${clone.path}-other` }), false)
  })

  it('labels a clone by its folder', () => {
    const branch = { ...clone, key: 'k', appId: 'a', addedAt: '' }
    assert.equal(registry.label(branch), `${clone.path} · dev`)
    assert.equal(registry.label({ kind: 'local', path: clone.path, key: 'k', appId: 'a', addedAt: '' }), `${clone.path} · working tree`)
  })
})
