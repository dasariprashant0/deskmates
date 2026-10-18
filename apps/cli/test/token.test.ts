import { expect, test } from 'vitest'
import { newToken } from '../src/token'

test('43 chars base64url', () => { expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/) })
test('1000 unique', () => { expect(new Set(Array.from({ length: 1000 }, newToken)).size).toBe(1000) })
