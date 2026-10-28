import { stripVTControlCharacters, styleText } from "node:util";

export type Style = Parameters<typeof styleText>[0];

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
  /** Share of the width left after fixed columns; flexible columns shrink (to `min`) to fit the terminal. */
  flex?: number;
  min?: number;
  /** Dropped when the table can't fit even with flexible columns at their minimum (flexible ones first). */
  optional?: boolean;
  style?: (row: T) => Style | undefined;
}

export interface TableOptions<T> {
  /** Total width to fit; Infinity never truncates. */
  width?: number;
  /** Whether to emit ANSI styles; by default only on a color-capable TTY (NO_COLOR/FORCE_COLOR respected). */
  color?: boolean;
  /** Style applied to a whole row on top of the column style (e.g. dim superseded memories). */
  rowStyle?: (row: T) => Style | undefined;
}

const segmenter = new Intl.Segmenter();
// Emoji shown as pictures and East Asian wide/fullwidth characters take two terminal cells.
const WIDE = /\p{Emoji_Presentation}|️|[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;

const graphemes = (s: string) => Array.from(segmenter.segment(s), ({ segment }) => segment);
const cellWidth = (g: string) => (WIDE.test(g) ? 2 : 1);

/** Terminal cells taken by `s` (ANSI codes ignored). */
export const displayWidth = (s: string) => graphemes(stripVTControlCharacters(s)).reduce((w, g) => w + cellWidth(g), 0);

/** Cut `s` to at most `max` cells, marking the cut with an ellipsis. */
export const truncate = (s: string, max: number) => {
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const g of graphemes(s)) {
    if (w + cellWidth(g) > max - 1) break;
    out += g;
    w += cellWidth(g);
  }
  return `${out}…`;
};

const pad = (s: string, width: number, align: "left" | "right" = "left") => {
  const fill = " ".repeat(Math.max(0, width - displayWidth(s)));
  return align === "right" ? fill + s : s + fill;
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Width of the terminal stdout is attached to; COLUMNS when piped, else unlimited. */
export const terminalWidth = () => (process.stdout.isTTY ? process.stdout.columns : Number(process.env.COLUMNS) || Number.POSITIVE_INFINITY);

/** Cells used by borders and padding: "│ a │ b │" */
const chrome = (n: number) => 3 * n + 1;

/**
 * Fixed columns get their natural width. Flexible ones share the rest by flex weight (water-filling: a column
 * narrower than its share keeps its natural width and frees the remainder for the others), never below `min`.
 */
function fit<T>(columns: Column<T>[], cells: string[][], width: number) {
  const widths = columns.map((c, i) => Math.max(displayWidth(c.header), ...cells.map((row) => displayWidth(row[i]!))));
  let room = width - chrome(columns.length) - widths.reduce((sum, w, i) => sum + (columns[i]!.flex ? 0 : w), 0);
  let pending = columns.flatMap((c, i) => (c.flex ? [i] : []));
  while (pending.length) {
    const totalFlex = pending.reduce((sum, i) => sum + columns[i]!.flex!, 0);
    const share = (i: number) => (room * columns[i]!.flex!) / totalFlex;
    const satisfied = pending.filter((i) => widths[i]! <= share(i));
    if (!satisfied.length) {
      for (const i of pending) widths[i] = Math.max(columns[i]!.min ?? 1, Math.floor(share(i)));
      break;
    }
    for (const i of satisfied) room -= widths[i]!;
    pending = pending.filter((i) => !satisfied.includes(i));
  }
  return { widths, fits: widths.reduce((a, b) => a + b, 0) + chrome(columns.length) <= width };
}

/** Render rows as a box-drawn table that fits the terminal, dropping optional columns if needed. */
export function renderTable<T>(rows: T[], columns: Column<T>[], { width = terminalWidth(), color, rowStyle }: TableOptions<T> = {}): string {
  const cells = rows.map((r) => columns.map((c) => oneLine(c.value(r))));
  const { widths, fits } = fit(columns, cells, width);
  // Too narrow: drop an optional column (flexible ones first, they cost the most) and try again.
  const drop = [columns.findLastIndex((c) => c.optional && c.flex), columns.findLastIndex((c) => c.optional)].find((i) => i >= 0);
  if (!fits && drop !== undefined) return renderTable(rows, columns.toSpliced(drop, 1), { width, color, rowStyle });

  // styleText checks stdout itself unless colors are forced on or off.
  const paint = (text: string, ...styles: (Style | undefined)[]) => {
    const s = styles.flat().filter((x) => x !== undefined);
    return s.length && color !== false ? styleText(s as Style, text, { validateStream: color !== true }) : text;
  };
  const border = (l: string, m: string, r: string) => paint(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r, "dim");
  const bar = paint("│", "dim");
  const line = (texts: string[], styleOf: (i: number) => (Style | undefined)[]) =>
    `${bar} ${texts.map((t, i) => paint(pad(truncate(t, widths[i]!), widths[i]!, columns[i]!.align), ...styleOf(i))).join(` ${bar} `)} ${bar}`;

  return [
    border("╭", "┬", "╮"),
    line(columns.map((c) => c.header), () => ["bold"]),
    border("├", "┼", "┤"),
    ...rows.map((r, ri) => line(cells[ri]!, (i) => [rowStyle?.(r), columns[i]!.style?.(r)])),
    border("╰", "┴", "╯"),
  ].join("\n");
}
