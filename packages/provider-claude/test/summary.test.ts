import { describe, expect, test } from 'vitest'
import { summarize, toolActivity } from '../src/index'

describe('summarize', () => {
  test('Bash keeps only the first word', () => {
    expect(summarize('Bash', { command: 'curl -H "Authorization: Bearer sk-FAKE-000" https://x.test/a?k=1' })).toBe('Bash: curl')
  })
  test('file tools keep basename only', () => {
    expect(summarize('Read', { file_path: '/Users/x/.env' })).toBe('Read: .env file')
    expect(summarize('Edit', { file_path: '/a/.env.production' })).toBe('Edit: .env file')
    expect(summarize('Write', { file_path: '/a/.envrc' })).toBe('Write: .envrc')
    expect(summarize('Read', { file_path: '/a/env.ts' })).toBe('Read: env.ts')
    expect(summarize('NotebookEdit', { notebook_path: '/a/b/n.ipynb' })).toBe('NotebookEdit: n.ipynb')
  })
  test('WebFetch keeps hostname only', () => {
    expect(summarize('WebFetch', { url: 'https://a.test/p?token=1' })).toBe('WebFetch: a.test')
    expect(summarize('WebFetch', { url: 'not a url' })).toBe('WebFetch')
  })
  test('Grep pattern is truncated', () => {
    expect(summarize('Grep', { pattern: 'x'.repeat(80) })).toBe('Grep: ' + 'x'.repeat(24))
  })
  test('WebSearch and Agent', () => {
    expect(summarize('WebSearch', { query: 'secret' })).toBe('WebSearch')
    expect(summarize('Agent', { description: 'd'.repeat(50) })).toBe('Agent: ' + 'd'.repeat(30))
  })
  test('non-object input never throws', () => {
    for (const n of ['Read', 'Bash', 'Grep', 'WebFetch', 'Agent', 'Other'])
      for (const i of [null, undefined, 5, 'str', [], { file_path: 5, command: {} }])
        expect(typeof summarize(n, i)).toBe('string')
    expect(summarize('Bash', null)).toBe('Bash')
  })
  test('mcp tools use last segment; others use name', () => {
    expect(summarize('mcp__srv__do_thing', {})).toBe('do_thing')
    expect(summarize('Custom', {})).toBe('Custom')
  })
  test('after-colon part never exceeds 40 chars', () => {
    expect(summarize('Read', { file_path: '/a/' + 'f'.repeat(100) }).split(': ')[1]!.length).toBeLessThanOrEqual(40)
    expect(summarize('Bash', { command: 'c'.repeat(100) })).toBe('Bash')
  })
})

describe('toolActivity', () => {
  test('maps tools', () => {
    expect(toolActivity('Read')).toBe('reading')
    expect(toolActivity('Glob')).toBe('reading')
    expect(toolActivity('Write')).toBe('editing')
    expect(toolActivity('Bash')).toBe('running')
    expect(toolActivity('WebFetch')).toBe('searching')
    expect(toolActivity('Agent')).toBe('running')
    expect(toolActivity('mcp__a__b')).toBe('running')
    expect(toolActivity('Zzz')).toBe('running')
  })
})

describe('hardening', () => {
  test('toolActivity ignores the prototype chain', () => {
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(toolActivity(n)).toBe('running')
  })
  test('Bash skips leading NAME=value tokens and strips paths', () => {
    expect(summarize('Bash', { command: 'API_KEY=sk-FAKE-000 curl x' })).toBe('Bash: curl')
    expect(summarize('Bash', { command: 'A=1 B=2 /usr/bin/make all' })).toBe('Bash: make')
    expect(summarize('Bash', { command: 'API_KEY=sk-FAKE-000' })).toBe('Bash')
    expect(summarize('Bash', { command: 'A="sk-FAKE 000" curl' })).toBe('Bash')
    expect(summarize('Bash', { command: '/Users/x/secret/run.sh --go' })).toBe('Bash: run.sh')
    expect(summarize('Bash', { command: '/' })).toBe('Bash')
  })
  test('sudo and env are deliberately not special-cased', () => {
    expect(summarize('Bash', { command: 'sudo rm -rf x' })).toBe('Bash: sudo')
    expect(summarize('Bash', { command: 'env FOO=bar ls' })).toBe('Bash: env')
  })
  test('no secret or path leaks in any Bash label', () => {
    const l = summarize('Bash', { command: 'API_KEY=sk-FAKE-000 /Users/x/secret/run.sh' })
    expect(l).not.toMatch(/sk-FAKE|Users|secret/)
  })
})

describe('Bash allowlist', () => {
  const cases: [string, string][] = [
    ['--token=abc cmd', 'Bash'],
    ['"FOO=bar" cmd', 'Bash'],
    ['FOO=a\\ b cmd', 'Bash'],
    ["FOO=$'a b' cmd", 'Bash'],
    ['KEY=$(cat s) cmd', 'Bash'],
    ['--url=https://x/SECRET', 'Bash'],
    ['env FOO=bar cmd', 'Bash: env'],
    ['./relative/tool', 'Bash: tool'],
    ['~/bin/x', 'Bash: x'],
    ['$(cmd)', 'Bash'],
    ['`cmd`', 'Bash'],
    ['a;b', 'Bash'],
    ['--flag', 'Bash'],
    ['', 'Bash'],
    ['   ', 'Bash'],
    ['x'.repeat(500), 'Bash'],
    ['caf\u00e9 arg', 'Bash'],
    ['sudo rm -rf x', 'Bash: sudo'],
    ['g++ a.cc', 'Bash: g++'],
    ['FOO=bar BAZ=1 ls', 'Bash: ls'],
  ]
  test.each(cases)('%j -> %s', (command, expected) => {
    expect(summarize('Bash', { command })).toBe(expected)
  })
})

describe('code-point-aware truncation', () => {
  test('does not split a surrogate pair at the cut', () => {
    const l = summarize('Grep', { pattern: 'a'.repeat(23) + '\u{1F600}tail' })
    expect(l).toBe('Grep: ' + 'a'.repeat(23) + '\u{1F600}')
    expect(l).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})
