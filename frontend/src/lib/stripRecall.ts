export function stripMemoryRecall(text: string): string {
  return text.replace(/<memory-recall>[\s\S]*?<\/memory-recall>\s*/g, '').trim()
}
