const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

const params = (s: string): string[] => s.replace(/^[#?]/, '').split('&')

/** Parses `#t=<token>` (extra params tolerated). Returns only well-formed tokens. */
export function readToken(hash: string): string | undefined {
  for (const p of params(hash)) {
    if (p.startsWith('t=')) {
      const t = p.slice(2)
      return TOKEN_RE.test(t) ? t : undefined
    }
  }
  return undefined
}

/** Removes the fragment (and so the token) from the address bar and history entry. */
export function stripFragment(
  history: { replaceState(data: unknown, unused: string, url?: string): void },
  location: { pathname: string; search: string },
): void {
  history.replaceState(null, '', location.pathname + location.search)
}

export function isDemo(location: { search: string; hash: string }): boolean {
  return params(location.search).includes('demo=1') || params(location.hash).includes('demo')
}
