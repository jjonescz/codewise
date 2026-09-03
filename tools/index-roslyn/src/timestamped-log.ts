export function formatTimestampedLogEntry(
  message: string,
  timestamp: Date = new Date()
): string {
  const prefix = `[${timestamp.toISOString()}] `;
  const lines = message.replaceAll("\r\n", "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return `${lines.map((line) => `${prefix}${line}`).join("\n")}\n`;
}
