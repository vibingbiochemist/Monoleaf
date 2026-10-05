import { CommentEntry, CommentThread } from "./comments";
import { formatShortcut } from "./platform";

export interface SidebarHandlers {
  onChangeName(): void;
  onReply(id: string, text: string): void;
  onResolve(id: string, resolved: boolean): void;
  onDelete(id: string): void;
  onDeleteResolved(): void;
  onSelect(id: string): void;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTs(ts: string): string {
  return ts.replace("T", " ").slice(0, 16);
}

function entryNode(entry: CommentEntry): HTMLElement {
  const node = el("div", "comment-entry");
  node.appendChild(
    el("div", "comment-meta", `${entry.author} · ${formatTs(entry.ts)}`),
  );
  node.appendChild(el("div", "comment-text", entry.text));
  return node;
}

function card(t: CommentThread, handlers: SidebarHandlers): HTMLElement {
  const node = el("div", t.resolved ? "comment-card resolved" : "comment-card");
  node.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, textarea") !== null) return;
    handlers.onSelect(t.id);
  });

  for (const entry of t.thread) node.appendChild(entryNode(entry));
  if (t.anchor === null) {
    node.appendChild(
      el("div", "comment-warning", "Anchor deleted from the text."),
    );
  }

  const actions = el("div", "comment-actions");
  const reply = document.createElement("textarea");
  reply.className = "reply-input";
  reply.placeholder = "Reply…";
  reply.rows = 1;
  const replyBtn = el("button", "comment-btn", "Reply") as HTMLButtonElement;
  replyBtn.addEventListener("click", () => {
    const text = reply.value.trim();
    if (text !== "") handlers.onReply(t.id, text);
  });
  const resolveBtn = el(
    "button",
    "comment-btn",
    t.resolved ? "Reopen" : "Resolve",
  ) as HTMLButtonElement;
  resolveBtn.addEventListener("click", () => {
    handlers.onResolve(t.id, !t.resolved);
  });
  const deleteBtn = el(
    "button",
    "comment-btn comment-btn-danger",
    "Delete",
  ) as HTMLButtonElement;
  deleteBtn.title = "Delete this thread from the document";
  deleteBtn.addEventListener("click", () => handlers.onDelete(t.id));
  actions.appendChild(reply);
  actions.appendChild(replyBtn);
  actions.appendChild(resolveBtn);
  actions.appendChild(deleteBtn);
  node.appendChild(actions);
  return node;
}

export function renderSidebar(
  container: HTMLElement,
  threads: CommentThread[],
  author: string,
  handlers: SidebarHandlers,
): void {
  container.textContent = "";

  const header = el("div", "sidebar-header");
  header.appendChild(el("span", "sidebar-author", `Commenting as ${author}`));
  const changeBtn = el("button", "comment-btn", "Change");
  changeBtn.addEventListener("click", () => handlers.onChangeName());
  header.appendChild(changeBtn);
  container.appendChild(header);

  const withBody = threads.filter((t) => t.body !== null);
  if (withBody.length === 0) {
    container.appendChild(
      el(
        "p",
        "sidebar-empty",
        formatShortcut(
          "No comments yet. Select text and press Ctrl+Shift+M or use the Comment button.",
        ),
      ),
    );
    return;
  }
  const open = withBody.filter((t) => !t.resolved);
  const resolved = withBody.filter((t) => t.resolved);
  for (const t of open) container.appendChild(card(t, handlers));
  if (resolved.length > 0) {
    // The bulk action sits on the Resolved heading rather than in the top
    // header: it only exists while there is something resolved to delete,
    // and it reads as acting on exactly the list beneath it.
    const heading = el("div", "sidebar-section-row");
    heading.appendChild(
      el("h3", "sidebar-section", `Resolved (${resolved.length})`),
    );
    const deleteAllBtn = el(
      "button",
      "comment-btn comment-btn-danger",
      "Delete all",
    );
    deleteAllBtn.title = "Delete every resolved thread from the document";
    deleteAllBtn.addEventListener("click", () => handlers.onDeleteResolved());
    heading.appendChild(deleteAllBtn);
    container.appendChild(heading);
    for (const t of resolved) container.appendChild(card(t, handlers));
  }
}
