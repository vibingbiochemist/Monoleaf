/**
 * Document outline sidebar: a live, clickable tree of the document's headings
 * for quick navigation in long documents. Purely a navigation aid — it reads
 * the headings via collectHeadings() and never changes the document.
 */
import { EditorView } from "@codemirror/view";
import { collectHeadings } from "./commands";

export function renderOutline(view: EditorView, container: HTMLElement): void {
  const headings = collectHeadings(view.state);
  container.replaceChildren();

  const header = document.createElement("div");
  header.className = "outline-header";
  header.textContent = "Outline";
  container.appendChild(header);

  if (headings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "outline-empty";
    empty.textContent = "No headings yet.";
    container.appendChild(empty);
    return;
  }

  const minLevel = Math.min(...headings.map((h) => h.level));
  const cursorLine = view.state.doc.lineAt(
    view.state.selection.main.head,
  ).number;
  // Active = the last heading at or before the cursor's line.
  let activeIdx = -1;
  headings.forEach((h, i) => {
    if (h.line <= cursorLine) activeIdx = i;
  });

  const list = document.createElement("div");
  list.className = "outline-list";
  headings.forEach((h, i) => {
    const item = document.createElement("button");
    item.className = "outline-item" + (i === activeIdx ? " active" : "");
    item.style.paddingLeft = `${10 + (h.level - minLevel) * 14}px`;
    item.textContent = h.title || "(untitled)";
    item.title = h.title;
    item.addEventListener("click", () => {
      const line = view.state.doc.line(h.line);
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "start" }),
      });
      view.focus();
    });
    list.appendChild(item);
  });
  container.appendChild(list);
}
