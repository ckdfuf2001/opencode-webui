export function stripMemoryRecall(text: string): string {
  return text
    .replace(/<memory-recall>[\s\S]*?<\/memory-recall>\s*/g, '')
    .replace(/<skill-memory-check>[\s\S]*?<\/skill-memory-check>\s*/g, '')
    .trim()
}
