import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import * as tar from 'tar'
import { archiveLocal, git, GitMissing, githubRemote, localHead, peekLocal, resolveLocal, UNTRACKED_LIMIT } from './local-git'
import { parseInput } from './source-url'
import { cleanup, tempDir, useUserData } from './testing'
import type { LocalSource } from './types'

const realFetch = globalThis.fetch
let data: string
let root: string

before(() => {
  data = useUserData()
  root = tempDir('trymydev-git-')
})
afterEach(() => {
  globalThis.fetch = realFetch
})
after(() => cleanup(data, root))

let count = 0

/** A clone with one commit on main, in a folder whose name holds a space. */
async function clone(): Promise<string> {
  const dir = join(root, `my project ${++count}`)
  mkdirSync(join(dir, 'sub'), { recursive: true })
  await git(['init', '-q', '-b', 'main'], dir)
  for (const [key, value] of [['user.email', 'tester@example.com'], ['user.name', 'Tester'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    await git(['config', key, value], dir)
  }
  writeFileSync(join(dir, 'app.txt'), 'committed')
  writeFileSync(join(dir, 'sub', 'keep.txt'), 'kept')
  await git(['add', '.'], dir)
  await git(['commit', '-q', '-m', 'first'], dir)
  return dir
}

const local = (text: string): Extract<ReturnType<typeof parseInput>, { kind: 'local' }> => {
  const parsed = parseInput(text)
  assert.equal(parsed.kind, 'local')
  return parsed as Extract<ReturnType<typeof parseInput>, { kind: 'local' }>
}

/** What the archive of a commit or tree holds, extracted as provisioning does. */
async function extract(src: LocalSource, object: string): Promise<string> {
  const out = tempDir('trymydev-extract-')
  const file = join(out, 'sources.tar.gz')
  await archiveLocal(src, object, file)
  const dir = join(out, 'checkout')
  mkdirSync(dir)
  await tar.x({ file, cwd: dir, strip: 1 })
  return dir
}

describe('githubRemote', () => {
  it('reads owner and repository over HTTPS and SSH', () => {
    for (const url of [
      'https://github.com/lightningpixel/modly.git',
      'https://github.com/lightningpixel/modly',
      'https://user@github.com/lightningpixel/modly.git',
      'git@github.com:lightningpixel/modly.git',
      'ssh://git@github.com/lightningpixel/modly.git'
    ]) {
      assert.deepEqual(githubRemote(url), { owner: 'lightningpixel', repo: 'modly' }, url)
    }
  })

  it('ignores other hosts', () => {
    assert.equal(githubRemote('https://gitlab.com/o/r.git'), undefined)
    assert.equal(githubRemote('git@github.example.com:o/r.git'), undefined)
    assert.equal(githubRemote(''), undefined)
  })
})

describe('resolveLocal', () => {
  it('finds the top level from a subfolder, and follows the folder without a branch', async () => {
    const dir = await clone()
    const resolved = await resolveLocal(local(join(dir, 'sub')))
    assert.equal(relative(resolved.source.path, dir), '')
    assert.equal(resolved.source.ref, undefined)
    assert.equal(resolved.upstream, undefined, 'no remote: an application of its own')
    assert.equal(resolved.name, `my project ${count}`)
  })

  it('takes the branch after @', async () => {
    const dir = await clone()
    await git(['branch', 'feat/my-branch'], dir)
    const resolved = await resolveLocal(local(`${dir}@feat/my-branch`))
    assert.equal(resolved.source.ref, 'feat/my-branch')
  })

  it('follows a detached HEAD too, but not a repository without a commit', async () => {
    const dir = await clone()
    await git(['checkout', '-q', '--detach'], dir)
    assert.equal((await resolveLocal(local(dir))).source.ref, undefined)
    const empty = join(root, `empty ${++count}`)
    mkdirSync(empty)
    await git(['init', '-q'], empty)
    await assert.rejects(resolveLocal(local(empty)), /no commit yet/)
  })

  it('belongs to the GitHub application of origin, through the root of its forks', async () => {
    const dir = await clone()
    await git(['remote', 'add', 'origin', 'git@github.com:someone/modly.git'], dir)
    const asked: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input))
      return new Response(JSON.stringify({ full_name: 'someone/modly', source: { full_name: 'lightningpixel/modly' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    assert.equal((await resolveLocal(local(dir))).upstream, 'lightningpixel/modly')
    assert.deepEqual(asked, ['https://api.github.com/repos/someone/modly'])
  })

  it('falls back on origin itself when GitHub cannot be asked', async () => {
    const dir = await clone()
    await git(['remote', 'add', 'origin', 'https://github.com/someone/modly.git'], dir)
    globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch
    assert.equal((await resolveLocal(local(dir))).upstream, 'someone/modly')
  })

  it('refuses relative paths, folders outside a repository and unknown branches', async () => {
    const dir = await clone()
    await assert.rejects(resolveLocal({ kind: 'local', path: 'my project' }), /Not an absolute path/)
    const outside = tempDir('trymydev-plain-')
    await assert.rejects(resolveLocal(local(outside)), /not inside a Git working tree/)
    await assert.rejects(resolveLocal(local(join(outside, 'gone'))), /Folder not found/)
    await assert.rejects(resolveLocal(local(`${dir}@nope`)), /No branch "nope"/)
    await cleanup(outside)
  })

  it('refuses what is not a branch name: options, revision expressions, invalid names', async () => {
    const dir = await clone()
    for (const ref of ['-x', '--output=x', 'a..b', '@{-1}', 'main^', 'has space', 'x.lock', 'a:b']) {
      await assert.rejects(resolveLocal({ kind: 'local', path: dir, ref }), /Not a valid branch name/, ref)
    }
  })

  it('says when git is missing', async () => {
    const dir = await clone()
    const path = process.env.PATH
    process.env.PATH = join(root, 'nothing-here')
    try {
      await assert.rejects(resolveLocal(local(dir)), (err) => err instanceof GitMissing && /install it/.test(err.message))
    } finally {
      process.env.PATH = path
    }
  })
})

describe('localHead and archiveLocal', () => {
  /** Loose objects in the clone: what a read wrote into the repository. */
  const objects = async (dir: string): Promise<string> => (await git(['count-objects'], dir)).split(' ')[0]

  it('never runs a program the repository config names to list changes', async () => {
    const dir = await clone()
    const hook = join(root, 'fsmonitor.sh').replace(/\\/g, '/')
    writeFileSync(hook, `#!/bin/sh\necho ran > "${hook}.ran"\n`, { mode: 0o755 })
    await git(['config', 'core.fsmonitor', hook], dir)
    writeFileSync(join(dir, 'changed.txt'), 'new')
    const src: LocalSource = { kind: 'local', path: dir }
    await localHead(src)
    await peekLocal(src)
    assert.equal(existsSync(`${hook}.ran`), false)
  })

  it('refuses a folder whose own config declares Git filters, before any of them runs', async () => {
    const dir = await clone()
    const hook = join(root, 'filter.sh').replace(/\\/g, '/')
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${hook}.ran"\ncat\n`, { mode: 0o755 })
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n')
    await git(['config', 'filter.evil.clean', hook], dir)
    await git(['config', 'filter.evil.smudge', hook], dir)
    writeFileSync(join(dir, 'changed.txt'), 'new')
    const src: LocalSource = { kind: 'local', path: dir }
    await assert.rejects(resolveLocal(local(dir)), /Git filters in its own config \(filter\.evil\.clean, filter\.evil\.smudge\)/)
    await assert.rejects(localHead(src), /Git filters/)
    await assert.rejects(peekLocal(src), /Git filters/)
    await assert.rejects(archiveLocal(src, await git(['rev-parse', 'HEAD'], dir), join(root, 'x.tar.gz')), /Git filters/)
    assert.equal(existsSync(`${hook}.ran`), false)

    // Git LFS's own filters, installed in the repository, are what they are everywhere.
    await git(['config', '--unset', 'filter.evil.clean'], dir)
    await git(['config', '--unset', 'filter.evil.smudge'], dir)
    await git(['config', 'filter.lfs.clean', 'git-lfs clean -- %f'], dir)
    rmSync(join(dir, '.gitattributes'))
    assert.ok((await localHead(src)).sha)
  })

  it('builds the branch commit, read without network', async () => {
    const dir = await clone()
    const src: LocalSource = { kind: 'local', path: dir, ref: 'main' }
    const { sha } = await localHead(src)
    assert.equal(sha, await git(['rev-parse', 'main'], dir))
    const checkout = await extract(src, sha)
    assert.equal(readFileSync(join(checkout, 'app.txt'), 'utf-8'), 'committed')
    assert.equal(readFileSync(join(checkout, 'sub', 'keep.txt'), 'utf-8'), 'kept')
    await cleanup(join(checkout, '..'))
  })

  it('follows the folder as it is: changed, added, untracked and deleted files, not ignored ones, and leaves the clone alone', async () => {
    const dir = await clone()
    writeFileSync(join(dir, 'app.txt'), 'changed')
    writeFileSync(join(dir, 'added.txt'), 'added')
    await git(['add', 'added.txt'], dir)
    writeFileSync(join(dir, 'untracked.txt'), 'untracked')
    mkdirSync(join(dir, 'new folder'))
    writeFileSync(join(dir, 'new folder', 'deep.txt'), 'deep')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(dir, 'ignored.txt'), 'ignored')
    await rm(join(dir, 'sub', 'keep.txt'))
    const before = await git(['status', '--porcelain', '--untracked-files=all'], dir)
    const index = readFileSync(join(dir, '.git', 'index'))

    const src: LocalSource = { kind: 'local', path: dir }
    const lines: string[] = []
    const head = await localHead(src, (line) => lines.push(line))
    assert.notEqual(head.sha, await git(['rev-parse', 'main'], dir))
    assert.match(lines.join('\n'), /main, uncommitted and untracked files included/)
    assert.equal((await localHead(src)).sha, head.sha, 'the same files give the same tree: the cache holds')

    const checkout = await extract(src, head.sha)
    assert.equal(readFileSync(join(checkout, 'app.txt'), 'utf-8'), 'changed')
    assert.equal(readFileSync(join(checkout, 'added.txt'), 'utf-8'), 'added')
    assert.equal(readFileSync(join(checkout, 'untracked.txt'), 'utf-8'), 'untracked')
    assert.equal(readFileSync(join(checkout, 'new folder', 'deep.txt'), 'utf-8'), 'deep')
    assert.equal(existsSync(join(checkout, 'ignored.txt')), false, '.gitignore is honoured')
    assert.equal(existsSync(join(checkout, 'sub', 'keep.txt')), false, 'a deleted file is gone')
    await cleanup(join(checkout, '..'))

    assert.equal(await git(['status', '--porcelain', '--untracked-files=all'], dir), before, 'working tree untouched')
    assert.deepEqual(readFileSync(join(dir, '.git', 'index')), index, 'the index untouched')
    assert.equal(await git(['stash', 'list'], dir), '', 'the stash untouched')
    assert.equal((await localHead({ ...src, ref: 'main' })).sha, await git(['rev-parse', 'main'], dir), 'a named branch: its commit only')
  })

  it('follows whatever is checked out, and builds the commit when nothing is uncommitted', async () => {
    const dir = await clone()
    const src: LocalSource = { kind: 'local', path: dir }
    assert.equal((await localHead(src)).sha, await git(['rev-parse', 'main'], dir))

    await git(['checkout', '-q', '-b', 'other'], dir)
    writeFileSync(join(dir, 'app.txt'), 'on other')
    await git(['commit', '-q', '-am', 'other'], dir)
    assert.equal((await localHead(src)).sha, await git(['rev-parse', 'other'], dir))

    await git(['checkout', '-q', '--detach', 'main'], dir)
    assert.equal((await localHead(src)).sha, await git(['rev-parse', 'main'], dir))
  })

  it('keeps the known sources while the folder has not moved, without writing to the repository', async () => {
    const dir = await clone()
    writeFileSync(join(dir, 'untracked.txt'), 'one')
    const src: LocalSource = { kind: 'local', path: dir }
    const first = await localHead(src)
    assert.ok(first.fingerprint)

    const written = await objects(dir)
    const lines: string[] = []
    assert.equal((await localHead(src, (line) => lines.push(line), first)).sha, first.sha)
    assert.match(lines.join('\n'), /unchanged/)
    assert.equal(await peekLocal(src, first), first.sha)
    assert.equal(await objects(dir), written, 'nothing written for a folder that did not move')

    // Still untracked, still listed the same way by git status: its size and time tell.
    writeFileSync(join(dir, 'untracked.txt'), 'two, longer')
    const peeked = await peekLocal(src, first)
    assert.notEqual(peeked, first.sha)
    assert.equal(await objects(dir), written, 'a check never writes')
    const second = await localHead(src, undefined, first)
    assert.notEqual(second.sha, first.sha)
    assert.notEqual(second.fingerprint, first.fingerprint)
  })

  it('stops on untracked files past the limit, naming the largest', async () => {
    const dir = await clone()
    writeFileSync(join(dir, 'model.bin'), Buffer.alloc(4096))
    writeFileSync(join(dir, 'small.txt'), 'x')
    const limit = { ...UNTRACKED_LIMIT }
    UNTRACKED_LIMIT.bytes = 2048
    try {
      await assert.rejects(localHead({ kind: 'local', path: dir }), /2 untracked file\(s\)[\s\S]*model\.bin[\s\S]*\.gitignore/)
      UNTRACKED_LIMIT.bytes = limit.bytes
      UNTRACKED_LIMIT.files = 1
      await assert.rejects(localHead({ kind: 'local', path: dir }), /2 untracked file\(s\)[\s\S]*files/)
      UNTRACKED_LIMIT.files = limit.files

      writeFileSync(join(dir, '.git', 'info', 'exclude'), 'model.bin\n')
      UNTRACKED_LIMIT.bytes = 2048
      await localHead({ kind: 'local', path: dir })
      await localHead({ kind: 'local', path: dir, ref: 'main' })
    } finally {
      Object.assign(UNTRACKED_LIMIT, limit)
    }
  })

  it('warns about .env files .gitignore leaves out of the build', async () => {
    const dir = await clone()
    writeFileSync(join(dir, '.gitignore'), '.env\n.env.*\n')
    writeFileSync(join(dir, '.env'), 'TOKEN=x')
    writeFileSync(join(dir, '.env.example'), 'TOKEN=')
    mkdirSync(join(dir, 'api'))
    writeFileSync(join(dir, 'api', '.env.local'), 'TOKEN=x')
    writeFileSync(join(dir, 'sub', '.env.kept'), 'tracked on purpose')
    await git(['add', '-f', 'sub/.env.kept'], dir)
    const { warnings } = await localHead({ kind: 'local', path: dir })
    assert.deepEqual(warnings?.map((w) => w.split(' ')[0]).sort(), ['.env', 'api/.env.local'])
    assert.match(warnings![0], /left out: \.gitignore excludes it/)
  })

  it('refuses to archive anything but an object id', async () => {
    const dir = await clone()
    await assert.rejects(archiveLocal({ kind: 'local', path: dir, ref: 'main' }, '--remote=x', join(root, 'x.tgz')), /Not a git object/)
  })
})
