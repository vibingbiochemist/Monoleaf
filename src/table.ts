/**
 * GFM pipe-table model: parse, edit operations, serialize. Pure functions —
 * the interactive widget (tablewidget.ts) is DOM plumbing over this. The
 * file representation stays a plain GFM table; column alignment maps to the
 * delimiter-row colons (:--- / :---: / ---:), which is real markdown.
 */

export type ColAlign = "none" | "left" | "center" | "right";

export interface TableModel {
  header: string[];
  aligns: ColAlign[];
  rows: string[][];
}

/** Split a table row on pipes, honoring backslash-escaped \| in cells. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (const ch of trimmed) {
    if (escaped) {
      cell += ch === "|" ? "|" : `\\${ch}`;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

export interface RowCellSpan {
  /** The exact line.slice(start, end) — deliberately NOT unescaped (unlike
   * splitRow's cells), so raw.length === end - start always holds. Callers
   * needing the model's unescaped text still go through splitRow/TableModel. */
  raw: string;
  start: number;
  end: number;
}

const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** Trim ws from [start, end) within line, returning the trimmed span. */
function trimSpan(line: string, start: number, end: number): RowCellSpan {
  let s = start;
  let e = end;
  while (s < e && isWs(line[s])) s++;
  while (e > s && isWs(line[e - 1])) e--;
  return { raw: line.slice(s, e), start: s, end: e };
}

/**
 * Position-aware sibling of splitRow: same escape-aware pipe-boundary
 * scanning (leading/trailing pipe stripped, \| doesn't end a cell, each
 * cell trimmed), but reports each cell's [start, end) offset within `line`
 * instead of returning an unescaped model string. Used to map an absolute
 * editor position (e.g. a page-break) back to "which cell, what offset" —
 * see resolveExactBreakPos (pagination.ts) and buildDecorations
 * (tablewidget.ts).
 */
export function splitRowWithPositions(line: string): RowCellSpan[] {
  const cells: RowCellSpan[] = [];

  // Mirror splitRow's line.trim().replace(/^\|/, "").replace(/\|$/, ""), but
  // track positions in the ORIGINAL string instead of a separate copy.
  let i = 0;
  const n = line.length;
  while (i < n && isWs(line[i])) i++;
  let end = n;
  while (end > i && isWs(line[end - 1])) end--;
  if (i < end && line[i] === "|") i++;
  if (end > i && line[end - 1] === "|") end--;

  let cellStart = i;
  let escaped = false;
  for (let p = i; p < end; p++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (line[p] === "\\") {
      escaped = true;
      continue;
    }
    if (line[p] === "|") {
      // CodeQL flags this as js/incomplete-sanitization: the `escaped`
      // backslash-tracking above superficially resembles an escaper that
      // "misses" backslashes, but this function isn't sanitizing anything —
      // it's a boundary finder that deliberately returns exact, untouched
      // substrings (raw.length === end - start always holds; see the
      // doc comment above), so escaping was never the goal here.
      cells.push(trimSpan(line, cellStart, p)); // lgtm[js/incomplete-sanitization]
      cellStart = p + 1;
    }
  }
  cells.push(trimSpan(line, cellStart, end));
  return cells;
}

function parseAlign(cell: string): ColAlign | null {
  const t = cell.trim();
  if (!/^:?-+:?$/.test(t)) return null;
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "none";
}

export function parseTableText(text: string): TableModel | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const aligns =
    lines[1].trim().startsWith("|") || lines[1].includes("|")
      ? splitRow(lines[1]).map(parseAlign)
      : null;
  if (aligns === null || aligns.some((a) => a === null)) return null;
  const rows = lines.slice(2).map(splitRow);
  return normalize({
    header,
    aligns: aligns as ColAlign[],
    rows,
  });
}

/** Pad every row to the widest column count. */
export function normalize(m: TableModel): TableModel {
  const cols = Math.max(
    m.header.length,
    m.aligns.length,
    ...m.rows.map((r) => r.length),
    1,
  );
  const pad = (r: string[]) =>
    r.length >= cols
      ? r.slice(0, cols)
      : [...r, ...Array(cols - r.length).fill("")];
  return {
    header: pad(m.header),
    aligns:
      m.aligns.length >= cols
        ? m.aligns.slice(0, cols)
        : [...m.aligns, ...Array(cols - m.aligns.length).fill("none")],
    rows: m.rows.map(pad),
  };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function delimiter(a: ColAlign): string {
  switch (a) {
    case "center":
      return ":---:";
    case "right":
      return "---:";
    case "left":
      return ":---";
    default:
      return "---";
  }
}

/** Serialize with \n; the caller converts to the document's line break. */
export function serializeTable(m: TableModel): string {
  const n = normalize(m);
  const row = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [
    row(n.header),
    `| ${n.aligns.map(delimiter).join(" | ")} |`,
    ...n.rows.map(row),
  ].join("\n");
}

// --- operations (all return a new model) -----------------------------------

export function setCell(
  m: TableModel,
  row: number, // -1 = header
  col: number,
  text: string,
): TableModel {
  const n = normalize(m);
  if (row === -1) {
    const header = [...n.header];
    header[col] = text;
    return { ...n, header };
  }
  const rows = n.rows.map((r) => [...r]);
  if (rows[row] === undefined) return n;
  rows[row][col] = text;
  return { ...n, rows };
}

export function insertRow(m: TableModel, at: number): TableModel {
  const n = normalize(m);
  const rows = [...n.rows];
  rows.splice(
    Math.max(0, Math.min(at, rows.length)),
    0,
    Array(n.header.length).fill(""),
  );
  return { ...n, rows };
}

export function deleteRow(m: TableModel, at: number): TableModel {
  const n = normalize(m);
  if (n.rows.length <= 1 || n.rows[at] === undefined) return n;
  const rows = n.rows.filter((_, i) => i !== at);
  return { ...n, rows };
}

export function insertCol(m: TableModel, at: number): TableModel {
  const n = normalize(m);
  const i = Math.max(0, Math.min(at, n.header.length));
  const ins = (r: string[]) => [...r.slice(0, i), "", ...r.slice(i)];
  return {
    header: ins(n.header),
    aligns: [...n.aligns.slice(0, i), "none", ...n.aligns.slice(i)],
    rows: n.rows.map(ins),
  };
}

export function deleteCol(m: TableModel, at: number): TableModel {
  const n = normalize(m);
  if (n.header.length <= 1 || at < 0 || at >= n.header.length) return n;
  const del = (r: string[]) => r.filter((_, i) => i !== at);
  return {
    header: del(n.header),
    aligns: del(n.aligns) as ColAlign[],
    rows: n.rows.map(del),
  };
}

export function setAlign(
  m: TableModel,
  col: number,
  align: ColAlign,
): TableModel {
  const n = normalize(m);
  if (n.aligns[col] === undefined) return n;
  const aligns = [...n.aligns];
  aligns[col] = align;
  return { ...n, aligns };
}

/** A fresh empty table skeleton. */
export function emptyTable(cols = 3, rows = 2): TableModel {
  return {
    header: Array.from({ length: cols }, (_, i) => `Column ${i + 1}`),
    aligns: Array(cols).fill("none"),
    rows: Array.from({ length: rows }, () => Array(cols).fill("")),
  };
}
