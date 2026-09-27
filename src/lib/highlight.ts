/**
 * Finds the parts of a log line worth coloring: the level (INFO, WARN, ERROR, ...),
 * HTTP methods and timestamps. The message itself is left alone so it stays easy to read.
 *
 * Pure text in, token ranges out. `screenHighlight.ts` applies them to what's on screen.
 */

export type TokenKind = "error" | "warn" | "info" | "debug" | "method" | "time";

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const levelWord = (upper: string, lower: string) =>
  String.raw`\b(?:${upper})\b|\[(?:${lower})\]` +
  // JSON loggers: "level": "error" and logfmt: level=error.
  String.raw`|(?<="(?:level|severity|lvl|levelname)"\s*:\s*)"(?:${lower}|${upper})"` +
  String.raw`|(?<=\blevel\s*=\s*)(?:${lower}|${upper})\b`;

/** Earlier rules win when two match at the same position. */
const RULES: [pattern: string, kind: TokenKind][] = [
  [levelWord("ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|SEVERE|EMERG|ALERT", "error|err|fatal|critical|crit|panic|emerg|alert"), "error"],
  [levelWord("WARN|WARNING", "warn|warning"), "warn"],
  [levelWord("INFO|NOTICE", "info|notice"), "info"],
  [levelWord("DEBUG|TRACE|VERBOSE", "debug|trace|verbose"), "debug"],
  [String.raw`\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b`, "method"],
  // Only the entry's own timestamp at the start of the line; dates inside the message stay plain.
  [
    String.raw`(?<=^\[?)\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b` +
      String.raw`|(?<=^\S+ \S+ \S+ \[)\d{2}\/${MON}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?` +
      String.raw`|^${MON} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\b`,
    "time",
  ],
];

const PATTERN = new RegExp(RULES.map(([p], i) => `(?<r${i}>${p})`).join("|"), "g");

export function findTokens(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(PATTERN)) {
    if (!m[0] || !m.groups) continue;
    for (let i = 0; i < RULES.length; i++) {
      if (m.groups[`r${i}`] !== undefined) {
        tokens.push({ start: m.index, end: m.index + m[0].length, kind: RULES[i][1] });
        break;
      }
    }
  }
  return tokens;
}
