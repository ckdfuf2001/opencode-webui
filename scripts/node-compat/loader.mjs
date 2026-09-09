// node --import 등록용 커스텀 리졸버.
// 1) `bun:sqlite` -> ./bun-sqlite.mjs (node:sqlite 기반 심)
// 2) 확장자 없는 상대 import (bundler 스타일) -> .ts/.js//index.ts 탐색
//    (node ESM은 확장자를 강제하므로 bun과 동일하게 동작하도록 보정)
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SHIM_URL = new URL('./bun-sqlite.mjs', import.meta.url).href;
const HAS_EXT = /\.(ts|mts|cts|js|mjs|cjs|json|node)$/;

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'bun:sqlite') {
    return { url: SHIM_URL, shortCircuit: true };
  }
  const parentURL = context.parentURL ?? '';
  const isRelative =
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../');
  if (isRelative && parentURL.startsWith('file:') && !HAS_EXT.test(specifier)) {
    const base = path.resolve(path.dirname(fileURLToPath(parentURL)), specifier);
    const candidates = [
      base + '.ts',
      base + '.js',
      base + '.mjs',
      base + '.cjs',
      base + '.json',
      path.join(base, 'index.ts'),
      path.join(base, 'index.js'),
    ];
    for (const c of candidates) {
      if (isFile(c)) {
        return { url: pathToFileURL(c).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
