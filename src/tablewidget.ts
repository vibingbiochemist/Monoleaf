import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Extension,
  StateCommand,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { MenuItem } from "./contextmenu";
import { cellDisplayHtml, cellHasRichContent } from "./tablecell";
import {
  ColAlign,
  deleteCol,
  deleteRow,
  emptyTable,
  insertCol,
  insertRow,
  parseTableText,
  serializeTable,
  setAlign,
  setCell,
  TableModel,
} from "./table";

/**
 * Word-style table editing in the live view: the whole GFM table block is
 * replaced by an interactive grid widget. Cell edits are committed back into
 * the markdown on blur / Tab / Enter — the file never contains anything but
 * a plain pipe table. Raw view (Ctrl+Q) shows and edits the source.
 * Block widgets spanning line breaks must be provided by a StateField.
 */

const refreshTables = StateEffect.define<null>();

// Focus to restore after a commit rebuilds the widget (same table start).
let pendingFocus: { from: number; row: number; col: number } | null = null;
// Last focused cell, for the toolbar operations.
let activeCell: { row: number; col: number } = { row: -1, col: 0 };

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly model: TableModel,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  get estimatedHeight() {
    return (this.model.rows.length + 2) * 38;
  }
  ignoreEvent() {
    return true;
  }
  toDOM(view: EditorView) {
    return buildTableDom(view, this);
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const decos: ReturnType<Decoration["range"]>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const source = state.sliceDoc(node.from, node.to);
      const model = parseTableText(source);
      if (model === null) return;
      decos.push(
        Decoration.replace({
          widget: new TableWidget(source, node.from, model),
          block: true,
        }).range(node.from, node.to),
      );
      return false;
    },
  });
  return Decoration.set(decos, true);
}

export const tableField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(refreshTables))) {
      return buildDecorations(tr.state);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The syntax tree parses asynchronously: when it advances without a document
// change (e.g. after opening a file), rebuild the table widgets once.
const tableRefresher = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (
        !update.docChanged &&
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        window.setTimeout(() => {
          update.view.dispatch({ effects: refreshTables.of(null) });
        });
      }
    }
  },
);

export function tableExtensions(): Extension {
  return [tableField, tableRefresher];
}

/** Current document range of the given widget (positions move with edits). */
function widgetRange(
  view: EditorView,
  widget: TableWidget,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  const it = view.state.field(tableField).iter();
  while (it.value !== null) {
    if ((it.value.spec as { widget?: WidgetType }).widget === widget) {
      found = { from: it.from, to: it.to };
      break;
    }
    it.next();
  }
  return found;
}

function commitModel(
  view: EditorView,
  widget: TableWidget,
  model: TableModel,
  focus: { row: number; col: number } | null,
) {
  const range = widgetRange(view, widget);
  if (range === null) return;
  const text = serializeTable(model).replace(/\n/g, view.state.lineBreak);
  if (focus !== null) pendingFocus = { from: range.from, ...focus };
  if (text === view.state.sliceDoc(range.from, range.to)) {
    // No text change: just restore focus if requested.
    if (focus !== null) focusCell(view, range.from, focus.row, focus.col);
    return;
  }
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    userEvent: "input.table",
  });
}

function focusCell(view: EditorView, from: number, row: number, col: number) {
  requestAnimationFrame(() => {
    const cell = view.dom.querySelector<HTMLElement>(
      `.ml-table-wrap[data-from="${from}"] [data-row="${row}"][data-col="${col}"]`,
    );
    cell?.focus();
    if (cell !== null) {
      // Cursor at end of cell content.
      const sel = window.getSelection();
      if (sel !== null && cell.firstChild !== null) {
        sel.selectAllChildren(cell);
        sel.collapseToEnd();
      }
    }
  });
}

/**
 * Show a cell the way the PDF/HTML export shows it: inline HTML from the safe
 * subset rendered, entities resolved (see tablecell.ts). The markdown source
 * stays in `data-raw` — a rendered cell reads back through `textContent` as
 * flattened text, so every commit path compares against `data-raw` and the
 * cell is switched back to its raw source while focused for editing.
 */
function showCell(cell: HTMLElement, raw: string) {
  cell.dataset.raw = raw;
  if (cellHasRichContent(raw)) cell.innerHTML = cellDisplayHtml(raw);
  else cell.textContent = raw;
}

/** The markdown source of a cell, regardless of whether it is rendered. */
function cellRaw(cell: HTMLElement): string {
  return cell.dataset.raw ?? "";
}

/** Swap a rendered cell to its raw source so typing edits real markdown. */
function revealCellSource(cell: HTMLElement) {
  const raw = cellRaw(cell);
  if (cell.textContent === raw) return; // plain cell: nothing was rendered
  cell.textContent = raw;
  // Content length just changed under the caret, so a click-derived offset is
  // meaningless. Put it at the end, the same convention focusCell() uses.
  const sel = window.getSelection();
  if (sel !== null && cell.firstChild !== null) {
    sel.selectAllChildren(cell);
    sel.collapseToEnd();
  }
}

function buildTableDom(view: EditorView, widget: TableWidget): HTMLElement {
  const model = widget.model;
  const wrap = document.createElement("div");
  wrap.className = "ml-table-wrap";
  wrap.dataset.from = String(widget.from);

  // --- hover toolbar --------------------------------------------------------
  const bar = document.createElement("div");
  bar.className = "ml-table-bar";
  const op = (label: string, title: string, action: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep cell focus for coordinate context
      e.stopPropagation();
      action();
    });
    bar.appendChild(b);
    return b;
  };
  const current = () => latestModel(view, widget);
  op("+ Row", "Insert row below the current cell", () => {
    const at = activeCell.row + 1;
    commitModel(view, widget, insertRow(current(), at), {
      row: at,
      col: activeCell.col,
    });
  });
  op("− Row", "Delete the current row", () => {
    if (activeCell.row < 0) return;
    commitModel(view, widget, deleteRow(current(), activeCell.row), {
      row: Math.max(0, activeCell.row - 1),
      col: activeCell.col,
    });
  });
  op("+ Col", "Insert column after the current cell", () => {
    const at = activeCell.col + 1;
    commitModel(view, widget, insertCol(current(), at), {
      row: activeCell.row,
      col: at,
    });
  });
  op("− Col", "Delete the current column", () => {
    commitModel(view, widget, deleteCol(current(), activeCell.col), {
      row: activeCell.row,
      col: Math.max(0, activeCell.col - 1),
    });
  });
  for (const [label, align] of [
    ["⇤", "left"],
    ["↔", "center"],
    ["⇥", "right"],
  ] as [string, ColAlign][]) {
    op(label, `Align column ${align}`, () => {
      commitModel(view, widget, setAlign(current(), activeCell.col, align), {
        row: activeCell.row,
        col: activeCell.col,
      });
    });
  }
  op("✕", "Delete table", () => {
    const range = widgetRange(view, widget);
    if (range !== null) {
      view.dispatch({
        changes: { from: range.from, to: range.to },
        userEvent: "delete.table",
      });
      view.focus();
    }
  });
  wrap.appendChild(bar);

  // --- the grid --------------------------------------------------------------
  const table = document.createElement("table");
  table.className = "ml-table";
  const mkCell = (
    tag: "th" | "td",
    row: number,
    col: number,
    text: string,
    align: ColAlign,
  ) => {
    const cell = document.createElement(tag);
    cell.contentEditable = "plaintext-only";
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    showCell(cell, text);
    if (align !== "none") cell.style.textAlign = align;
    return cell;
  };
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  model.header.forEach((text, c) =>
    hr.appendChild(mkCell("th", -1, c, text, model.aligns[c])),
  );
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  model.rows.forEach((cells, r) => {
    const tr = document.createElement("tr");
    cells.forEach((text, c) =>
      tr.appendChild(mkCell("td", r, c, text, model.aligns[c])),
    );
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  // --- events ----------------------------------------------------------------
  const cellOf = (t: EventTarget | null): HTMLElement | null =>
    t instanceof HTMLElement ? t.closest<HTMLElement>("[data-row]") : null;

  wrap.addEventListener("focusin", (e) => {
    const cell = cellOf(e.target);
    if (cell !== null) {
      activeCell = {
        row: Number(cell.dataset.row),
        col: Number(cell.dataset.col),
      };
      // Mark the cell as open for editing BEFORE revealing, so focusout can
      // tell a genuine edit session from a stray blur.
      cell.dataset.editing = "1";
      revealCellSource(cell);
    }
  });

  wrap.addEventListener("focusout", (e) => {
    const cell = cellOf(e.target);
    if (cell === null) return;
    // Only commit a cell that focusin actually opened. A focusout with no
    // matching focusin — a duplicate/bubbled blur, teardown on reload, or a
    // node rebuilt while focus moved — would otherwise read the RENDERED
    // text of the cell, whose <br> and &nbsp; have collapsed away, and
    // commit that back over the real markdown source.
    if (cell.dataset.editing !== "1") return;
    delete cell.dataset.editing;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const text = cell.textContent ?? "";
    const before = cellRaw(cell);
    // Re-render: on a real edit the widget is rebuilt from the document and
    // this node is discarded, but an unchanged cell must go back to rendered.
    showCell(cell, text);
    if (text !== before) {
      commitModel(
        view,
        widget,
        setCell(latestModel(view, widget), row, col, text),
        null,
      );
    }
  });

  wrap.addEventListener("keydown", (e) => {
    e.stopPropagation(); // CodeMirror must not interpret cell typing
    const cell = cellOf(e.target);
    if (cell === null) return;
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const cols = model.header.length;
    const commitAndFocus = (r: number, c: number, m?: TableModel) => {
      const withEdit = setCell(
        m ?? latestModel(view, widget),
        row,
        col,
        cell.textContent ?? "",
      );
      commitModel(view, widget, withEdit, { row: r, col: c });
    };
    if (e.key === "Tab") {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      let r = row;
      let c = col + dir;
      let m: TableModel | undefined;
      if (c >= cols) {
        c = 0;
        r = row + 1;
        if (r >= model.rows.length) {
          // Word behavior: Tab in the last cell adds a row.
          m = insertRow(latestModel(view, widget), model.rows.length);
        }
      } else if (c < 0) {
        c = cols - 1;
        r = row - 1;
        if (r < -1) return;
      }
      commitAndFocus(r, c, m);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = row + 1;
      if (r < model.rows.length) commitAndFocus(r, col);
      else commitAndFocus(row, col); // commit in place at the bottom
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Restore from data-raw, not the (possibly stale) widget model, so the
      // focusout below sees no change and simply re-renders.
      cell.textContent = cellRaw(cell);
      cell.blur();
      view.focus();
    }
  });
  for (const type of [
    "beforeinput",
    "input",
    "mousedown",
    "paste",
    "copy",
    "cut",
  ]) {
    wrap.addEventListener(type, (e) => e.stopPropagation());
  }

  widgetByWrap.set(wrap, widget);

  // Restore focus after a commit rebuilt this widget.
  if (pendingFocus !== null && pendingFocus.from === widget.from) {
    const { row, col } = pendingFocus;
    pendingFocus = null;
    focusCell(view, widget.from, row, col);
  }

  return wrap;
}

/** The model as currently in the document (the widget's copy can be stale
 * between DOM events and rebuilds). */
function latestModel(view: EditorView, widget: TableWidget): TableModel {
  const range = widgetRange(view, widget);
  if (range === null) return widget.model;
  return (
    parseTableText(view.state.sliceDoc(range.from, range.to)) ?? widget.model
  );
}

const widgetByWrap = new WeakMap<HTMLElement, TableWidget>();

/**
 * Table actions for the right-clicked cell, composed into the editor's
 * general context menu as a "Table" submenu. Null when the click was not
 * inside a table widget.
 */
export function tableMenuItems(
  view: EditorView,
  target: EventTarget | null,
): MenuItem[] | null {
  if (!(target instanceof HTMLElement)) return null;
  const cell = target.closest<HTMLElement>("[data-row]");
  const wrap = target.closest<HTMLElement>(".ml-table-wrap");
  if (cell === null || wrap === null) return null;
  const widget = widgetByWrap.get(wrap);
  if (widget === undefined) return null;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  const m = () => latestModel(view, widget);
  const alignItem = (label: string, align: ColAlign): MenuItem => ({
    kind: "item",
    label,
    action: () =>
      commitModel(view, widget, setAlign(m(), col, align), { row, col }),
  });
  return [
    {
      kind: "item",
      label: "Insert row above",
      disabled: row === -1,
      action: () =>
        commitModel(view, widget, insertRow(m(), row), { row, col }),
    },
    {
      kind: "item",
      label: "Insert row below",
      action: () =>
        commitModel(view, widget, insertRow(m(), row + 1), {
          row: row + 1,
          col,
        }),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Insert column left",
      action: () =>
        commitModel(view, widget, insertCol(m(), col), { row, col }),
    },
    {
      kind: "item",
      label: "Insert column right",
      action: () =>
        commitModel(view, widget, insertCol(m(), col + 1), {
          row,
          col: col + 1,
        }),
    },
    { kind: "separator" },
    alignItem("Align column left", "left"),
    alignItem("Align column center", "center"),
    alignItem("Align column right", "right"),
    { kind: "separator" },
    {
      kind: "item",
      label: "Delete row",
      disabled: row === -1,
      action: () =>
        commitModel(view, widget, deleteRow(m(), row), {
          row: Math.max(0, row - 1),
          col,
        }),
    },
    {
      kind: "item",
      label: "Delete column",
      action: () =>
        commitModel(view, widget, deleteCol(m(), col), {
          row,
          col: Math.max(0, col - 1),
        }),
    },
    {
      kind: "item",
      label: "Delete table",
      action: () => {
        const range = widgetRange(view, widget);
        if (range !== null) {
          view.dispatch({
            changes: { from: range.from, to: range.to },
            userEvent: "delete.table",
          });
          view.focus();
        }
      },
    },
  ];
}

/** Insert a fresh cols×rows table at the cursor, on its own paragraph. */
export function insertTableSized(cols: number, rows: number): StateCommand {
  return ({ state, dispatch }) => {
    const nl = state.lineBreak;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const table = serializeTable(emptyTable(cols, rows)).replace(/\n/g, nl);
    const before = range.from === line.from ? "" : nl + nl;
    const insert = `${before}${table}${nl}${nl}`;
    pendingFocus = { from: range.from + before.length, row: -1, col: 0 };
    dispatch(
      state.update({
        changes: { from: range.from, to: range.to, insert },
        selection: EditorSelection.cursor(range.from + insert.length),
        userEvent: "input.table",
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

export const insertTable: StateCommand = insertTableSized(3, 2);
