import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Journal } from '../overlay/journal'
import {
  AndroidDriver,
  apkPackage,
  findApk,
  logcatArgs,
  inputText,
  installFailure,
  LogcatJournal,
  packageOf,
  parseDevices,
  parseUiDump,
  renderUi,
  shellQuote,
  type Adb,
  type AndroidLaunch
} from './android'
import { cleanup, tempDir } from './testing'

const dirs: string[] = []
after(() => cleanup(...dirs))

function project(files: Record<string, string>): string {
  const dir = tempDir()
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

describe('adb devices', () => {
  it('tells a phone from an emulator, and one not allowed yet', () => {
    const devices = parseDevices(
      'List of devices attached\n' +
        'R5CT1234ABC            device usb:1-1 product:a55xnsxx model:SM_A556B device:a55x transport_id:2\n' +
        'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 transport_id:1\n' +
        '0123456789             unauthorized usb:1-2 transport_id:3\n\n'
    )
    assert.deepEqual(devices, [
      { serial: 'R5CT1234ABC', state: 'device', model: 'SM A556B', emulator: false },
      { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true },
      { serial: '0123456789', state: 'unauthorized', model: undefined, emulator: false }
    ])
  })

  it('quotes what the device shell reads, single quotes included', () => {
    assert.equal(shellQuote("it's; rm -rf /"), `'it'\\''s; rm -rf /'`)
  })
})

describe('the APK and the application id', () => {
  it('finds the newest APK of a folder, test builds left out', () => {
    const dir = project({
      'app/build/outputs/apk/debug/app-debug.apk': 'old',
      'app/build/outputs/apk/release/app-release.apk': 'new',
      'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk': 'test',
      'node_modules/x/build/outputs/apk/x.apk': 'dependency'
    })
    const old = join(dir, 'app/build/outputs/apk/debug/app-debug.apk')
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1))
    assert.equal(findApk(dir), join(dir, 'app/build/outputs/apk/release/app-release.apk'))
    assert.equal(findApk(dir, 'app/build/outputs/apk/debug'), old)
    assert.equal(findApk(dir, 'app/build/outputs/apk/debug/app-debug.apk'), old)
    assert.throws(() => findApk(dir, 'missing'), /No APK was found in missing/)
  })

  it('reads the application id from the Gradle build, Groovy or Kotlin', () => {
    const groovy = project({ 'android/app/build.gradle': 'apply plugin: "com.android.application"\nandroid {\n  defaultConfig {\n    applicationId "com.example.rn"\n  }\n}' })
    assert.equal(packageOf(groovy, { mode: 'android' }), 'com.example.rn')
    const kotlin = project({ 'mobile/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { namespace = "org.notes.app" }' })
    assert.equal(packageOf(kotlin, { mode: 'android' }), 'org.notes.app')
    assert.equal(packageOf(kotlin, { mode: 'android', package: 'given.by.manifest' }), 'given.by.manifest')
    assert.throws(() => packageOf(project({ 'README.md': '' }), { mode: 'android' }), /"package": "com.example.app"/)
  })

  it('explains an installation the phone refused, and never suggests uninstalling quietly', () => {
    assert.equal(installFailure('Performing Streamed Install\nSuccess\n'), undefined)
    assert.match(installFailure('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signatures do not match]') ?? '', /never uninstalls it/)
    assert.match(installFailure('Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]') ?? '', /Install via USB/)
  })
})

describe('logcat', () => {
  it('turns a crash and its stack into one entry named by its exception, and errors and warnings into theirs', () => {
    const journal = new Journal({})
    const reader = new LogcatJournal(journal)
    for (const line of [
      '10-04 12:00:01.234  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main',
      '10-04 12:00:01.234  4321  4321 E AndroidRuntime: Process: com.example, PID: 4321',
      '10-04 12:00:01.234  4321  4321 E AndroidRuntime: java.lang.IllegalStateException: Broken on purpose',
      '10-04 12:00:01.234  4321  4321 E AndroidRuntime: \tat com.example.MainActivity.lambda$onCreate$1(MainActivity.java:24)',
      '10-04 12:00:01.235  4321  4321 E MyActivity: Could not load the list',
      '10-04 12:00:01.236  4321  4330 W OkHttp: slow response',
      '10-04 12:00:01.237  4321  4321 D MyActivity: noise',
      '--------- beginning of main'
    ]) {
      reader.line(line)
    }
    reader.flush()
    const snap = journal.snapshot()
    assert.deepEqual(
      snap.errors.map((e) => [e.kind, e.text]),
      [
        ['error', 'MyActivity: Could not load the list'],
        ['crash', 'The application crashed: java.lang.IllegalStateException: Broken on purpose']
      ]
    )
    assert.match(snap.errors[1].detail ?? '', /MainActivity\.java:24/)
    assert.deepEqual(snap.warnings.map((e) => e.text), ['OkHttp: slow response'])
  })
})

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
  <node index="0" text="Sign in" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,100][1040,180]" />
  <node index="1" text="me@example.com" resource-id="com.example:id/email" class="android.widget.EditText" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[40,200][1040,320]" />
  <node index="2" text="hunter2" resource-id="com.example:id/password" class="android.widget.EditText" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="true" selected="false" bounds="[40,340][1040,460]" />
  <node index="3" text="" resource-id="com.example:id/go" class="android.widget.ImageButton" package="com.example" content-desc="Continue &amp; agree" checkable="false" checked="false" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,500][1040,620]" />
</node>
</hierarchy>`

describe('the screen as an agent reads it', () => {
  it('names what a tester sees, gives references to what they act on, and never a password', () => {
    const nodes = parseUiDump(DUMP)
    assert.equal(nodes.length, 5)
    assert.deepEqual(nodes[2].bounds, [40, 200, 1040, 320])
    const { text, refs } = renderUi(nodes)
    assert.equal(
      text,
      [
        '- text "Sign in"',
        '- textbox "me@example.com" [focused] [ref=e1]',
        '- textbox "password" [password] [ref=e2]',
        '- button "Continue & agree" [disabled] [ref=e3]'
      ].join('\n')
    )
    assert.doesNotMatch(text, /hunter2/)
    assert.equal(refs.get('e3')?.desc, 'Continue & agree')
  })

  it('types plain text only, spaces as adb expects them', () => {
    // Measured on an emulator: "\%" types a backslash, "a%sb" types "a b".
    assert.deepEqual(inputText('hello world 100%'), ['hello%sworld%s100%'])
    assert.deepEqual(inputText('a%sb'), ['a%', 'sb'])
    assert.deepEqual(inputText('%%s x'), ['%%', 's%sx'])
    assert.deepEqual(inputText(''), [])
    assert.throws(() => inputText('café'), /plain ASCII/)
  })

  it('follows logcat from the start of the run, of its process when known', () => {
    assert.deepEqual(logcatArgs('1791186876', 4242), ['logcat', '-v', 'threadtime', '-T', '1791186876.000', '--pid=4242'])
    assert.deepEqual(logcatArgs('', undefined), ['logcat', '-v', 'threadtime'])
  })

  it('reads the application id from the APK only when build tools are there', async () => {
    const sdk = tempDir('trymydev-sdk-')
    dirs.push(sdk)
    assert.equal(await apkPackage(join(sdk, 'app.apk'), undefined, sdk), undefined)
  })
})

describe('AndroidDriver', () => {
  function fake(): { driver: AndroidDriver; sent: string[][]; journal: Journal } {
    const sent: string[][] = []
    const adb = {
      shell: async (args: string[]) => {
        sent.push(args)
        if (args[0] === 'wm') return 'Physical size: 1080x2400\n'
        return ''
      },
      run: async (args: string[]) => (args[0] === 'exec-out' ? DUMP : ''),
      raw: async () => Buffer.from('png')
    } as unknown as Adb
    const journal = new Journal({})
    const launch = { adb, device: { serial: 'R5', state: 'device', model: 'Pixel 9', emulator: false }, pkg: 'com.example', journal } as unknown as AndroidLaunch
    return { driver: new AndroidDriver(launch, 'Example · main', undefined), sent, journal }
  }

  it('taps the centre of an element of the last snapshot, and records it', async () => {
    const { driver, sent, journal } = fake()
    await assert.rejects(driver.click('e1'), /take a snapshot first/)
    await driver.snapshot()
    await driver.click('e1')
    assert.deepEqual(sent.at(-1), ['input', 'tap', '540', '260'])
    assert.equal(journal.snapshot().timeline.at(-1)?.text, 'Tapped textbox "[email]"', 'masked as it is recorded')
  })

  it('replaces the text of a field, and names a password field without its content', async () => {
    const { driver, sent, journal } = fake()
    await driver.snapshot()
    await driver.type('e1', 'new me', true)
    assert.deepEqual(sent.slice(2), [
      ['input', 'keyevent', '123'],
      ['input', 'keyevent', ...Array<string>(14).fill('67')],
      ['input', 'text', 'new%sme'],
      ['input', 'keyevent', '66']
    ])
    await driver.type('e2', 'secret', false)
    assert.equal(journal.snapshot().timeline.at(-1)?.text, 'Typed into a password field')
  })

  it('scrolls with a swipe, and presses keys by their Android codes', async () => {
    const { driver, sent } = fake()
    await driver.scroll('down', undefined)
    assert.deepEqual(sent.at(-1), ['input', 'swipe', '540', '1800', '540', '600', '300'])
    await driver.press('Escape')
    assert.deepEqual(sent.at(-1), ['input', 'keyevent', '4'])
    await assert.rejects(driver.press('Control+S'), /Unknown key/)
  })
})
