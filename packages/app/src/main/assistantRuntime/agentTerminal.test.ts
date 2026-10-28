import { describe, expect, it } from 'vitest'
import { buildAgentTerminalEnvironment } from './agentTerminal'

describe('buildAgentTerminalEnvironment', () => {
  it('retains the host executable path while excluding secret-like variables', () => {
    const environment = buildAgentTerminalEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/agent',
        LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        GITHUB_TOKEN: 'secret'
      },
      'linux'
    )

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat'
    })
    expect(environment).not.toHaveProperty('HOME')
    expect(environment).not.toHaveProperty('LANG')
    expect(environment).not.toHaveProperty('OPENAI_API_KEY')
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(environment).not.toHaveProperty('GITHUB_TOKEN')
  })

  it('retains the Windows host variables needed to launch node and git', () => {
    const environment = buildAgentTerminalEnvironment(
      {
        path: 'C:\\tools',
        sYsTeMrOoT: 'C:\\Windows',
        WiNdIr: 'C:\\Windows',
        cOmSpEc: 'C:\\Windows\\System32\\cmd.exe',
        pAtHeXt: '.COM;.EXE',
        tEmP: 'C:\\Temp',
        TMP: 'C:\\Temp',
        NODE_AUTH_TOKEN: 'synthetic-token'
      },
      'win32'
    )

    expect(environment).toMatchObject({
      PATH: 'C:\\tools',
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp'
    })
    expect(environment).not.toHaveProperty('path')
    expect(environment).not.toHaveProperty('sYsTeMrOoT')
    expect(environment).not.toHaveProperty('cOmSpEc')
    expect(environment).not.toHaveProperty('NODE_AUTH_TOKEN')
  })

  it('retains exact standard locale variables without accepting prefixed credentials', () => {
    const environment = buildAgentTerminalEnvironment(
      {
        PATH: '/usr/bin',
        LC_ALL: 'C',
        LC_CTYPE: 'C.UTF-8',
        LC_MESSAGES: 'C',
        LC_TIME: 'C',
        LANGUAGE: 'en_US:zh_CN',
        LC_API_KEY: 'synthetic-lc-value',
        LANGUAGE_SECRET: 'synthetic-language-value',
        LC_TIME_ZONE: 'synthetic-locale-value',
        NODE_OPTIONS: 'synthetic-node-options'
      },
      'linux'
    )

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      LC_ALL: 'C',
      LC_CTYPE: 'C.UTF-8',
      LC_MESSAGES: 'C',
      LC_TIME: 'C',
      LANGUAGE: 'en_US:zh_CN'
    })
    expect(environment).not.toHaveProperty('LC_API_KEY')
    expect(environment).not.toHaveProperty('LANGUAGE_SECRET')
    expect(environment).not.toHaveProperty('LC_TIME_ZONE')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
  })

  it('forces pager and optional-lock settings over host values', () => {
    const environment = buildAgentTerminalEnvironment({
      PATH: '/usr/bin',
      GIT_OPTIONAL_LOCKS: '1',
      GIT_PAGER: 'less',
      PAGER: 'more'
    })

    expect(environment).toMatchObject({
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat'
    })
  })
})
