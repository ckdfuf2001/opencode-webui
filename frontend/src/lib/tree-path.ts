export function normalizeTreePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').toLowerCase()
}
