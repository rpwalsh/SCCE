function limitLines(text: string, max = 200): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= max) return text;
  return lines.slice(0, max).join('\n') + '\n... truncated';
}

export function limitLength(text: string, max = 20_000): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  return text.slice(0, max) + '\n... truncated';
}