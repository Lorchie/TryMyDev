import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { branchKey, isAbsolutePath, parseInput } from './source-url'

describe('parseInput', () => {
  it('reads a branch URL whose name contains slashes', () => {
    assert.deepEqual(
      parseInput('https://github.com/lightningpixel/modly/tree/feat/api-token-and-agent-guards'),
      { kind: 'github', owner: 'lightningpixel', repo: 'modly', ref: 'feat/api-token-and-agent-guards' }
    )
  })

  it('decodes an encoded ref and drops a trailing slash', () => {
    assert.deepEqual(parseInput('https://github.com/o/r/tree/feat%2Fx/'), {
      kind: 'github',
      owner: 'o',
      repo: 'r',
      ref: 'feat/x'
    })
  })

  it('reads a pull request URL, whatever tab it points at', () => {
    assert.deepEqual(parseInput('https://github.com/someone/modly/pull/42/files'), {
      kind: 'github',
      owner: 'someone',
      repo: 'modly',
      pr: 42
    })
  })

  it('accepts a repository address without scheme, with www or with .git', () => {
    assert.deepEqual(parseInput('github.com/Comfy-Org/ComfyUI'), { kind: 'github', owner: 'Comfy-Org', repo: 'ComfyUI' })
    assert.deepEqual(parseInput('https://www.github.com/Comfy-Org/ComfyUI.git'), {
      kind: 'github',
      owner: 'Comfy-Org',
      repo: 'ComfyUI'
    })
  })

  it('reads the short forms', () => {
    assert.deepEqual(parseInput('owner/modly@my-branch'), { kind: 'github', owner: 'owner', repo: 'modly', ref: 'my-branch' })
    assert.deepEqual(parseInput('owner/modly@feat/x'), { kind: 'github', owner: 'owner', repo: 'modly', ref: 'feat/x' })
    assert.deepEqual(parseInput('owner/modly'), { kind: 'github', owner: 'owner', repo: 'modly', ref: undefined })
  })

  it('ignores whitespace pasted around or inside the address', () => {
    assert.deepEqual(parseInput('  owner/modly @ dev \n'), { kind: 'github', owner: 'owner', repo: 'modly', ref: 'dev' })
  })

  it('rejects an empty address', () => {
    assert.throws(() => parseInput('   '), /Empty address/)
  })

  it('rejects other hosts and look-alikes', () => {
    assert.throws(() => parseInput('https://gitlab.com/owner/repo'), /Unrecognised address/)
    assert.throws(() => parseInput('https://githubXcom/owner/repo'), /Unrecognised address/)
  })
})

describe('parseInput, local clones', () => {
  it('reads a Windows path, with or without a branch', () => {
    assert.deepEqual(parseInput('C:\\Users\\me\\code\\modly@feat/ma-branche'), {
      kind: 'local',
      path: 'C:\\Users\\me\\code\\modly',
      ref: 'feat/ma-branche'
    })
    assert.deepEqual(parseInput('C:\\Users\\me\\code\\modly'), { kind: 'local', path: 'C:\\Users\\me\\code\\modly' })
    assert.deepEqual(parseInput('D:/code/modly@dev'), { kind: 'local', path: 'D:/code/modly', ref: 'dev' })
  })

  it('keeps spaces in a path and drops the quotes of "Copy as path"', () => {
    assert.deepEqual(parseInput('  "C:\\My Code\\modly"@dev \n'), { kind: 'local', path: 'C:\\My Code\\modly', ref: 'dev' })
  })

  it('reads POSIX and network paths', () => {
    assert.deepEqual(parseInput('/home/me/code/modly@feat/x'), { kind: 'local', path: '/home/me/code/modly', ref: 'feat/x' })
    assert.deepEqual(parseInput('\\\\server\\share\\modly'), { kind: 'local', path: '\\\\server\\share\\modly' })
  })

  it('does not take a folder holding @ for a branch', () => {
    assert.deepEqual(parseInput('C:\\Users\\me@corp\\modly'), { kind: 'local', path: 'C:\\Users\\me@corp\\modly' })
    assert.deepEqual(parseInput('C:\\Users\\me@corp\\modly@dev'), { kind: 'local', path: 'C:\\Users\\me@corp\\modly', ref: 'dev' })
  })

  it('gives no branch for a trailing @', () => {
    assert.deepEqual(parseInput('/code/modly@'), { kind: 'local', path: '/code/modly', ref: undefined })
  })

  it('does not take relative paths', () => {
    assert.throws(() => parseInput('.\\modly'), /Unrecognised address/)
    assert.throws(() => parseInput('code\\modly@dev'), /Unrecognised address/)
  })

  it('tells absolute paths of this system', () => {
    if (process.platform === 'win32') {
      assert.equal(isAbsolutePath('C:\\code'), true)
      assert.equal(isAbsolutePath('\\\\server\\share'), true)
      assert.equal(isAbsolutePath('/code'), false, 'relative to the current drive')
    } else {
      assert.equal(isAbsolutePath('/code'), true)
      assert.equal(isAbsolutePath('C:\\code'), false)
    }
  })
})

describe('branchKey', () => {
  const key = (ref: string, extra: { owner?: string; repo?: string; appId?: string } = {}): string =>
    branchKey(extra.appId ?? 'app', { kind: 'github', owner: extra.owner ?? 'o', repo: extra.repo ?? 'r', ref })

  it('is short: the ref, cut, and a hash', () => {
    assert.match(key('dev'), /^dev-[0-9a-f]{8}$/)
    assert.match(key('feat/api-token-and-agent-guards'), /^feat-api-token-and-agent-[0-9a-f]{8}$/)
    assert.ok(key('x'.repeat(200)).length <= 33)
  })

  it('stays a valid folder name whatever the ref', () => {
    assert.match(key('../..'), /^branch-[0-9a-f]{8}$/)
    assert.match(key('release/1.0.'), /^release-1\.0-[0-9a-f]{8}$/)
  })

  it('keeps apart refs a folder name would confuse, and other forks and applications', () => {
    assert.notEqual(key('fix/login'), key('fix-login'))
    assert.notEqual(key('Dev'), key('dev'))
    assert.notEqual(key('dev', { owner: 'fork' }), key('dev'))
    assert.notEqual(key('dev', { appId: 'other' }), key('dev'))
  })

  it('ignores the case of owner and repository, as GitHub does', () => {
    assert.equal(
      key('dev', { owner: 'Comfy-Org', repo: 'ComfyUI' }),
      key('dev', { owner: 'comfy-org', repo: 'comfyui' })
    )
  })

  it('keeps a local clone apart from GitHub, and the folder as it is apart from its branches', () => {
    const clone = { kind: 'local' as const, path: '/code/r', ref: 'dev' }
    assert.match(branchKey('app', clone), /^dev-[0-9a-f]{8}$/)
    assert.notEqual(branchKey('app', clone), key('dev'))
    assert.match(branchKey('app', { kind: 'local', path: '/code/r' }), /^local-[0-9a-f]{8}$/)
    assert.notEqual(branchKey('app', clone), branchKey('app', { kind: 'local', path: '/code/r' }))
    assert.notEqual(branchKey('app', clone), branchKey('app', { ...clone, path: '/code/other' }))
  })

  it('does not change the keys of GitHub branches', () => {
    assert.equal(key('main'), 'main-' + key('main').slice(-8))
    assert.equal(key('dev', { owner: 'o', repo: 'r', appId: 'o-r' }), branchKey('o-r', { kind: 'github', owner: 'o', repo: 'r', ref: 'dev' }))
  })
})
