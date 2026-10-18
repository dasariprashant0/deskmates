export const ANIMS = ['walk', 'idle', 'sit', 'type', 'read', 'think', 'celebrate', 'error'] as const
export const DIRS = ['down', 'up', 'left', 'right'] as const
export type Anim = (typeof ANIMS)[number]
export type Dir = (typeof DIRS)[number]
