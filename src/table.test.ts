import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { insertTable, tableField } from "./tablewidget";
import { markdownForMode } from "./portability";
import {
  deleteCol,
  deleteRow,
  emptyTable,
  insertCol,
  insertRow,
  parseTableText,
  serializeTable,
  setAlign,
  setCell,
} from "./table";

const SRC = `| Name | Kd | Notes |
| :--- | ---: | --- |
| ab1 | 0.4 | strong |
| ab2 | 12 | has \\| pipe |`;

describe("parse + serialize", () => {
  it("parses header, alignment, and rows", () => {
    const m = parseTableText(SRC)!;
    expect(m.header).toEqual(["Name", "Kd", "Notes"]);
    expect(m.aligns).toEqual(["left", "right", "none"]);
    expect(m.rows).toEqual([
      ["ab1", "0.4", "strong"],
      ["ab2", "12", "has | pipe"],
    ]);
  });

  it("round-trips through serialize + parse", () => {
    const m = parseTableText(SRC)!;
    const again = parseTableText(serializeTable(m))!;
    expect(again).toEqual(m);
  });

  it("serializes escaped pipes and alignment colons", () => {
    const s = serializeTable(parseTableText(SRC)!);
    expect(s).toContain("has \\| pipe");
    expect(s).toContain("| :--- | ---: | --- |");
  });

  it("rejects non-tables", () => {
    expect(parseTableText("just text\nmore text")).toBeNull();
    expect(parseTableText("| a |\n| b |")).toBeNull(); // no delimiter row
  });

  it("pads ragged rows to the widest column count", () => {
    const m = parseTableText("| a | b |\n| --- | --- |\n| 1 |")!;
    expect(m.rows[0]).toEqual(["1", ""]);
  });

  it("handles CRLF sources", () => {
    const m = parseTableText("| a |\r\n| --- |\r\n| 1 |\r\n")!;
    expect(m.rows).toEqual([["1"]]);
  });
});

describe("operations", () => {
  const m = parseTableText(SRC)!;

  it("setCell edits body and header cells", () => {
    expect(setCell(m, 0, 1, "0.5").rows[0][1]).toBe("0.5");
    expect(setCell(m, -1, 0, "Antibody").header[0]).toBe("Antibody");
  });

  it("insertRow / deleteRow", () => {
    const plus = insertRow(m, 1);
    expect(plus.rows).toHaveLength(3);
    expect(plus.rows[1]).toEqual(["", "", ""]);
    expect(deleteRow(plus, 1).rows).toEqual(m.rows);
  });

  it("deleteRow keeps at least one row", () => {
    const one = parseTableText("| a |\n| --- |\n| 1 |")!;
    expect(deleteRow(one, 0).rows).toHaveLength(1);
  });

  it("insertCol / deleteCol keep aligns in sync", () => {
    const plus = insertCol(m, 1);
    expect(plus.header).toEqual(["Name", "", "Kd", "Notes"]);
    expect(plus.aligns).toEqual(["left", "none", "right", "none"]);
    const back = deleteCol(plus, 1);
    expect(back.header).toEqual(m.header);
    expect(back.aligns).toEqual(m.aligns);
  });

  it("setAlign maps to delimiter colons", () => {
    const s = serializeTable(setAlign(m, 2, "center"));
    expect(s).toContain("| :--- | ---: | :---: |");
  });

  it("emptyTable produces a valid skeleton", () => {
    const s = serializeTable(emptyTable());
    const again = parseTableText(s)!;
    expect(again.header).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(again.rows).toHaveLength(2);
  });
});

describe("table widget field", () => {
  it("replaces Table nodes with a block widget", () => {
    const doc = `before\n\n${SRC}\n\nafter`;
    const state = EditorState.create({
      doc,
      extensions: [markdownForMode("enhanced"), tableField],
    });
    ensureSyntaxTree(state, doc.length, 5000);
    // Rebuild via an empty doc change so the field sees the full parse.
    const after = state.update({
      changes: { from: 0, insert: "" },
    }).state;
    const decos: number[] = [];
    const it2 = after.field(tableField).iter();
    while (it2.value !== null) {
      decos.push(it2.from);
      it2.next();
    }
    expect(decos).toEqual([doc.indexOf("| Name")]);
  });

  it("insertTable writes a skeleton and moves on", () => {
    const state = EditorState.create({
      doc: "text",
      selection: EditorSelection.single(4),
      extensions: markdownForMode("enhanced"),
    });
    let out = "";
    insertTable({
      state,
      dispatch: (tr) => {
        out = tr.state.doc.toString();
      },
    });
    expect(out).toContain("text\n\n| Column 1 | Column 2 | Column 3 |");
    expect(out).toContain("| --- | --- | --- |");
  });
});
