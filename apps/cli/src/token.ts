import { randomBytes } from 'node:crypto'

/** 32 random bytes as base64url: 43 chars from [A-Za-z0-9_-]. Never persisted. */
export const newToken = (): string => randomBytes(32).toString('base64url')
