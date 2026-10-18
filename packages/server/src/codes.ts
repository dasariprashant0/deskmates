/** Error-bucket key: only short identifier-like strings pass; anything else (attacker-influenced) is 'OTHER'. */
export const safeCode = (x: unknown): string => (typeof x === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(x) ? x : 'OTHER')
