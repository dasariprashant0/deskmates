import type { Activity } from '@deskmates/core'

const TABLE: Record<string, Activity> = {
  Read: 'reading', Grep: 'reading', Glob: 'reading',
  Edit: 'editing', Write: 'editing', NotebookEdit: 'editing',
  WebSearch: 'searching', WebFetch: 'searching',
}

export const toolActivity = (toolName: string): Activity => TABLE[toolName] ?? 'running'
