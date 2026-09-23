import { existsSync } from 'node:fs'
import path from 'node:path'

export interface DocToolCommand {
  command: string
  args: string[]
}

function resolveDocTool(exeName: string, scriptName: string): DocToolCommand {
  const exeCandidates = [
    path.join(process.cwd(), 'scripts', exeName),
    path.join(process.cwd(), 'backend', 'scripts', exeName),
  ]
  for (const candidate of exeCandidates) {
    if (existsSync(candidate)) {
      return { command: candidate, args: [] }
    }
  }
  return { command: 'python', args: [path.join(process.cwd(), 'backend', 'scripts', scriptName)] }
}

export function resolveDocReaderCommand(): DocToolCommand {
  // office-mcp fork (vendor/office-mcp/server.py) — 129 live tools + msg/embedded + compat.
  // Bridge port 8766 (8765 is the legacy doc-converter). Packaged exe wins when present.
  const exeCandidates = [
    path.join(process.cwd(), 'scripts', 'office-mcp.exe'),
    path.join(process.cwd(), 'backend', 'scripts', 'office-mcp.exe'),
  ]
  for (const candidate of exeCandidates) {
    if (existsSync(candidate)) {
      return { command: candidate, args: [] }
    }
  }
  const forkScript = path.join(process.cwd(), 'vendor', 'office-mcp', 'server.py')
  if (existsSync(forkScript)) {
    return { command: 'python', args: [forkScript] }
  }
  return resolveDocTool('doc-reader.exe', 'doc_reader_mcp.py')
}

export function resolveDocConverterCommand(): DocToolCommand {
  return resolveDocTool('doc-converter.exe', 'doc_converter.py')
}
