// Privacy-safe tool labels: never full paths, command arguments or URL paths/queries.
const MAX = 40
const str = (o: unknown, k: string): string | undefined => {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' && v ? v : undefined
}
const label = (name: string, v: string | undefined, max = MAX) =>
  v ? `${name}: ${v.slice(0, max)}` : name
const base = (p: string | undefined) => p?.split(/[\\/]/).filter(Boolean).pop()

// First program word of a shell command. Leading NAME=value tokens (often secrets) are skipped,
// quoted values containing spaces included; the program is reduced to its basename.
// sudo/env are deliberately NOT special-cased: the label stays 'Bash: sudo'.
const ENV = /^[A-Za-z_][A-Za-z0-9_]*=/
const program = (command: string | undefined) => {
  const t = command?.trim().split(/\s+/) ?? []
  let i = 0
  while (i < t.length && ENV.test(t[i]!)) {
    const v = t[i]!.slice(t[i]!.indexOf('=') + 1)
    const q = v[0] === '"' || v[0] === "'" ? v[0] : undefined
    if (q && (v.length < 2 || !v.endsWith(q))) { i++; while (i < t.length && !t[i]!.endsWith(q)) i++ }
    i++
  }
  return base(t[i])
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
