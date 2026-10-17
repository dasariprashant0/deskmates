import type { Activity } from '@deskmates/core'

// Map, not an object literal: no prototype-chain lookups ('constructor', '__proto__').
const TABLE = new Map<string, Activity>([
  ['Read', 'reading'], ['Grep', 'reading'], ['Glob', 'reading'],
  ['Edit', 'editing'], ['Write', 'editing'], ['NotebookEdit', 'editing'],
  ['WebSearch', 'searching'], ['WebFetch', 'searching'],
])

export const toolActivity = (toolName: string): Activity => TABLE.get(toolName) ?? 'running'
