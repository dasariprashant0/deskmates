// Short tool labels for the live (local-only) UI. Excluded: file contents, command arguments,
// URL paths/queries and secrets. NOT excluded: Grep/Glob pattern text (24 chars) and Agent
// description text (30 chars) are free-form user text, deliberately shown locally; any export
// pipeline must drop them.
const MAX = 40
const str = (o: unknown, k: string): string | undefined => {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' && v ? v : undefined
}
// Code-point-aware cut so a surrogate pair is never split.
const label = (name: string, v: string | undefined, max = MAX) =>
  v ? `${name}: ${Array.from(v).slice(0, max).join('')}` : name
const base = (p: string | undefined) => p?.split(/[\\/]/).filter(Boolean).pop()

// First program word of a shell command, by ALLOWLIST. Leading NAME=value tokens are skipped;
// an assignment value with any shell metacharacter, or a program token that is not a plain
// short name, gives just 'Bash'. sudo/env are deliberately NOT special-cased ('Bash: sudo').
const ENV = /^[A-Za-z_][A-Za-z0-9_]*=/
const META = /[\\$`'"();|&<>]/
const PLAIN = /^[A-Za-z0-9._+-]{1,32}$/
const program = (command: string | undefined) => {
  const t = command?.trim().split(/\s+/) ?? []
  let i = 0
  while (i < t.length && ENV.test(t[i]!)) {
    if (META.test(t[i]!.slice(t[i]!.indexOf('=') + 1))) return undefined
    i++
  }
  const tok = t[i]
  if (!tok || tok.startsWith('-') || tok.includes('=') || META.test(tok)) return undefined
  const b = base(tok)
  return b && PLAIN.test(b) ? b : undefined
}

export const summarize = (toolName: string, input: unknown): string => {
  try {
    switch (toolName) {
      case 'Read': case 'Edit': case 'Write':
        return label(toolName, base(str(input, 'file_path')))
      case 'NotebookEdit':
        return label(toolName, base(str(input, 'notebook_path')))
      case 'Bash':
        return label(toolName, program(str(input, 'command')))
      case 'Grep': case 'Glob':
        return label(toolName, str(input, 'pattern'), 24)
      case 'WebFetch': {
        try { return label(toolName, new URL(str(input, 'url') ?? '').hostname) } catch { return toolName }
      }
      case 'Agent':
        return label(toolName, str(input, 'description'), 30)
      default:
        return toolName.startsWith('mcp__') ? (toolName.split('__').pop() || toolName).slice(0, MAX) : toolName.slice(0, MAX)
    }
  } catch {
    return toolName
  }
}
