import type { Activity, AgentRef } from './events'

export type AgentKey = string // `${provider}:${sessionId}:${agentId ?? 'main'}`
export const agentKey = (ref: AgentRef): AgentKey => `${ref.provider}:${ref.sessionId}:${ref.agentId ?? 'main'}`

export type AgentStatus = 'idle' | 'working' | 'thinking' | 'waiting' | 'error' | 'done'
export type OpenTool = { name: string; summary: string; startedAt: number }
export type Attention = { toolUseId: string; source: 'heuristic' | 'hook'; requestId?: string; since: number }
export type Usage = { input: number; cacheWrite: number; cacheRead: number; output: number }
export type AgentState = {
  key: AgentKey
  ref: AgentRef
  cwd?: string
  title?: string
  model?: string
  gitBranch?: string
  status: AgentStatus
  activity: Activity
  openTools: Record<string, OpenTool>
  openOrder: string[] // open tool ids, oldest start first; currentTool is the last one
  currentTool?: OpenTool & { toolUseId: string }
  attention?: Attention
  usage: Usage
  startedAt: number
  lastEventAt: number
  endedAt?: number
  parentKey?: AgentKey
  children: AgentKey[]
  spawnDescription?: string
  agentType?: string
  lastError?: { toolUseId: string; at: number }
}
export type OfficeState = { agents: Record<AgentKey, AgentState>; order: AgentKey[]; seq: number }
export const emptyState = (): OfficeState => ({ agents: {}, order: [], seq: 0 })
