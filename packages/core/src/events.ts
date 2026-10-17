export type AgentRef = { provider: string; sessionId: string; agentId?: string; parentAgentId?: string }
export type Activity = 'thinking' | 'typing' | 'reading' | 'editing' | 'running' | 'searching' | 'idle'
export type NormalizedEvent = { seq: number; ts: number; agent: AgentRef } & (
  | { kind: 'session.start'; cwd: string; gitBranch?: string; title?: string; model?: string }
  | { kind: 'agent.spawn'; agentType?: string; description?: string; viaToolUseId?: string; depth: number }
  | { kind: 'agent.end'; reason: 'stop' | 'idle' | 'error' }
  | { kind: 'activity'; state: Activity }
  | { kind: 'tool.start'; toolUseId: string; name: string; summary: string }
  | { kind: 'tool.end'; toolUseId: string; isError: boolean }
  | { kind: 'attention'; toolUseId: string; source: 'heuristic' | 'hook'; requestId?: string }
  | { kind: 'attention.resolved'; toolUseId: string; decision?: 'allow' | 'deny' }
  | { kind: 'usage'; model: string; input: number; cacheWrite: number; cacheRead: number; output: number }
  | { kind: 'message'; role: 'user' | 'assistant'; chars: number }
)
