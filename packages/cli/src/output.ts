/**
 * Human-readable output helpers. The CLI prints plain text by default and exact
 * JSON with `--json`, so it is usable interactively and scriptable.
 */

export interface Printer {
  json: boolean;
  write(line?: string): void;
}

export function createPrinter(json: boolean): Printer {
  return {
    json,
    write(line = ''): void {
      process.stdout.write(`${line}\n`);
    },
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function heading(text: string): string {
  return `\n${text}`;
}

export function table(rows: string[][], headers: string[]): string {
  if (rows.length === 0) return '(none)';
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const renderRow = (row: string[]): string =>
    row
      .map((cell, index) => (cell ?? '').padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [renderRow(headers), renderRow(widths.map((width) => '-'.repeat(width))), ...rows.map(renderRow)].join('\n');
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export const STATUS_GLYPH: Record<string, string> = {
  ok: '✓',
  warn: '!',
  fail: '✗',
};
