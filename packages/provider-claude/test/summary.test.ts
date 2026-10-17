import { describe, expect, test } from 'vitest'
import { summarize, toolActivity } from '../src/index'

describe('summarize', () => {
  test('Bash keeps only the first word', () => {
    expect(summarize('Bash', { command: 'curl -H "Authorization: Bearer sk-FAKE-000" https://x.test/a?k=1' })).toBe('Bash: curl')
  })
  test('file tools keep basename only', () => {
    expect(summarize('Read', { file_path: '/Users/x/.env' })).toBe('Read: .env')
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
    expect(summarize('Bash', { command: 'c'.repeat(100) }).split(': ')[1]!.length).toBeLessThanOrEqual(40)
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
