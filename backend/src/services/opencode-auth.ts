function basicAuthHeader(): string | null {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return null
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

export function ensureServerAuth(headers: Record<string, string>): Record<string, string> {
  const existing = Object.keys(headers).find(k => k.toLowerCase() === 'authorization')
  if (existing) return headers
  const auth = getServerAuthHeader()
  if (auth) return { ...headers, Authorization: auth }
  return headers
}

export function getServerAuthHeader(): string | null {
  return basicAuthHeader()
}