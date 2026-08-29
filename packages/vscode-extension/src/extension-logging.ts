export interface LogOutput {
  appendLine(value: string): void;
}

export function logMessage(output: LogOutput, message: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(
  output: LogOutput,
  message: string,
  error: unknown
): void {
  logMessage(output, `${message}: ${formatError(error)}`);
}

export function formatError(error: unknown): string {
  const descriptions: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    descriptions.push(describeError(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return descriptions.join("\nCaused by: ");
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const code = Reflect.get(error, "code");
  const codeSuffix = typeof code === "string" || typeof code === "number"
    ? ` [code: ${String(code)}]`
    : "";
  const description = `${error.name}: ${error.message}${codeSuffix}`;
  if (error.stack === undefined) {
    return description;
  }

  const stackLines = error.stack.split(/\r?\n/u).slice(1);
  return stackLines.length === 0
    ? description
    : `${description}\n${stackLines.join("\n")}`;
}
