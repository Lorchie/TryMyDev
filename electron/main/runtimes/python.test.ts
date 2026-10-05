import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BranchLog } from '../logger'
import { cleanup, useUserData } from '../testing'
import { cachedUv, ensurePython, ensureUv, uvLayout } from './python'

const network = process.env.TRYMYDEV_NETWORK_TESTS === '1'
let data: string

before(() => {
  data = useUserData()
})
after(() => cleanup(data))

describe('cachedUv', () => {
  it('finds uv in the store, and nothing before it is there', async () => {
    assert.equal(await cachedUv(), undefined)
    const { dir, name } = uvLayout()
    const bin = join(dir, 'uv-x86_64-pc-windows-msvc', name)
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '')
    assert.equal(await cachedUv(), bin)
    // The network test below needs the real one.
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('ensurePython', { skip: network ? false : 'downloads uv and Python: set TRYMYDEV_NETWORK_TESTS=1' }, () => {
  it('installs the latest release of a minor line through uv, then finds it offline', async () => {
    const log = new BranchLog('app', 'python')
    const uv = await ensureUv(log)
    const python = await ensurePython('3.12', uv, log)

    assert.match(python.id, /^cpython-3\.12\.\d+$/)
    assert.ok(existsSync(python.bin))
    assert.deepEqual(await ensurePython('3.12.x', uv, log), python)
  })
})
