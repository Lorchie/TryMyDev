import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { platformOf, repositoryArchive } from './android'

const XML = `<sdk:sdk-repository>
  <remotePackage path="platform-tools">
    <type-details/><revision><major>37</major><minor>0</minor><micro>1</micro></revision>
    <channelRef ref="channel-0"/>
    <archives>
      <archive><complete><size>9</size><checksum type="sha1">${'a'.repeat(40)}</checksum><url>platform-tools_r37.0.1-linux.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><size>8</size><checksum type="sha1">${'b'.repeat(40)}</checksum><url>platform-tools_r37.0.1-win.zip</url></complete><host-os>windows</host-os></archive>
    </archives>
  </remotePackage>
  <remotePackage path="cmdline-tools;latest">
    <revision><major>24</major><minor>0</minor></revision>
    <channelRef ref="channel-3"/>
    <archives><archive><complete><size>1</size><checksum type="sha1">${'f'.repeat(40)}</checksum><url>canary.zip</url></complete><host-os>windows</host-os></archive></archives>
  </remotePackage>
  <remotePackage path="cmdline-tools;latest">
    <revision><major>23</major><minor>0</minor></revision>
    <channelRef ref="channel-0"/>
    <archives>
      <archive><complete><size>2</size><checksum type="sha1">${'c'.repeat(40)}</checksum><url>tools-mac_x86_64.zip</url></complete><host-os>macosx</host-os><host-arch>x64</host-arch></archive>
      <archive><complete><size>3</size><checksum type="sha1">${'d'.repeat(40)}</checksum><url>tools-mac_arm64.zip</url></complete><host-os>macosx</host-os><host-arch>aarch64</host-arch></archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>`

describe("Google's Android repository index", () => {
  it('gives the archive of this system, its sha1 and absolute address', () => {
    assert.deepEqual(repositoryArchive(XML, 'platform-tools', 'windows', 'x64'), {
      url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip',
      sha1: 'b'.repeat(40),
      size: 8,
      revision: '37.0.1'
    })
  })

  it('takes the stable channel, and the archive of the processor when archives differ by it', () => {
    const archive = repositoryArchive(XML, 'cmdline-tools;latest', 'macosx', 'aarch64')
    assert.equal(archive?.sha1, 'd'.repeat(40))
    assert.equal(archive?.revision, '23.0')
  })

  it('has nothing for a system no archive names', () => {
    assert.equal(repositoryArchive(XML, 'cmdline-tools;latest', 'linux', 'x64'), undefined)
    assert.equal(repositoryArchive(XML, 'emulator', 'windows', 'x64'), undefined)
  })
})

describe('the platform a project compiles against', () => {
  it('reads Groovy and Kotlin builds, and nothing from a variable', () => {
    assert.equal(platformOf('android {\n  compileSdk 35\n}'), 'platforms;android-35')
    assert.equal(platformOf('android { compileSdk = 34 }'), 'platforms;android-34')
    assert.equal(platformOf('compileSdkVersion 33'), 'platforms;android-33')
    assert.equal(platformOf('compileSdk = flutter.compileSdkVersion'), undefined)
  })
})
