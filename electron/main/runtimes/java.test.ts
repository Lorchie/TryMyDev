import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runtimeDir } from '../paths'
import { cleanup, useUserData } from '../testing'
import { cachedJava } from './java'

let data: string
before(() => {
  data = useUserData()
})
after(() => cleanup(data))

describe('cachedJava', () => {
  it('takes a JDK on disk only when it can compile', () => {
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
    const id = `jdk-17.0.20-${os}-${arch}`
    const bin = join(runtimeDir('java', id), ...(process.platform === 'darwin' ? ['Contents', 'Home'] : []), 'bin')
    const exe = (name: string): string => join(bin, process.platform === 'win32' ? `${name}.exe` : name)
    mkdirSync(bin, { recursive: true })
    writeFileSync(exe('java'), '')
    assert.equal(cachedJava('17'), null, 'java without javac: emptied by a cleaner')
    writeFileSync(exe('javac'), '')
    assert.equal(cachedJava('17')?.id, id)
  })
})
