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
  return resolveDocTool('doc-reader.exe', 'doc_reader_mcp.py')
}

export function resolveDocConverterCommand(): DocToolCommand {
  return resolveDocTool('doc-converter.exe', 'doc_converter.py')
}
