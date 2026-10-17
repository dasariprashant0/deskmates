// Privacy-safe tool labels: never full paths, command arguments or URL paths/queries.
const MAX = 40
const str = (o: unknown, k: string): string | undefined => {
  const v = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined
  return typeof v === 'string' && v ? v : undefined
}
const label = (name: string, v: string | undefined, max = MAX) =>
  v ? `${name}: ${v.slice(0, Math.min(max, MAX))}` : name
const base = (p: string | undefined) => p?.split(/[\\/]/).filter(Boolean).pop()

export const summarize = (toolName: string, input: unknown): string => {
  try {
    switch (toolName) {
      case 'Read': case 'Edit': case 'Write':
        return label(toolName, base(str(input, 'file_path')))
      case 'NotebookEdit':
        return label(toolName, base(str(input, 'notebook_path')))
      case 'Bash':
        return label(toolName, str(input, 'command')?.trim().split(/\s+/)[0])
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
