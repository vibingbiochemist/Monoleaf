/**
 * A small generic context-menu popup. The caller supplies the items; this
 * module only renders, positions within the viewport, and handles dismissal
 * (outside click, Escape, scroll, window blur).
 */

export type MenuItem =
  | {
      kind: "item";
      label: string;
      hint?: string;
      disabled?: boolean;
      strong?: boolean;
      action?: () => void;
    }
  | {
      kind: "row";
      buttons: { html: string; title: string; action: () => void }[];
    }
  | { kind: "separator" }
  | { kind: "note"; label: string }
  | { kind: "submenu"; label: string; items: MenuItem[] };

let current: HTMLElement | null = null;

export function closeContextMenu() {
  current?.remove();
  current = null;
}

function buildItems(menu: HTMLElement, items: MenuItem[]) {
  let openSubmenu: HTMLElement | null = null;
  const closeSubmenu = () => {
    openSubmenu?.remove();
    openSubmenu = null;
  };

  for (const item of items) {
    if (item.kind === "separator") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.appendChild(sep);
      continue;
    }
    if (item.kind === "note") {
      const note = document.createElement("div");
      note.className = "context-note";
      note.textContent = item.label;
      menu.appendChild(note);
      continue;
    }
    if (item.kind === "row") {
      const row = document.createElement("div");
      row.className = "context-format-row";
      for (const b of item.buttons) {
        const btn = document.createElement("button");
        btn.className = "icon-btn glyph";
        btn.title = b.title;
        btn.innerHTML = b.html;
        btn.addEventListener("click", () => {
          closeContextMenu();
          b.action();
        });
        row.appendChild(btn);
      }
      menu.appendChild(row);
      continue;
    }
    if (item.kind === "submenu") {
      const btn = document.createElement("button");
      btn.className = "menu-row";
      const label = document.createElement("span");
      label.textContent = item.label;
      btn.appendChild(label);
      const arrow = document.createElement("span");
      arrow.className = "menu-hint";
      arrow.textContent = "›";
      btn.appendChild(arrow);
      const open = () => {
        if (openSubmenu?.dataset.for === item.label) return;
        closeSubmenu();
        const sub = document.createElement("div");
        sub.className = "menu submenu";
        sub.dataset.for = item.label;
        buildItems(sub, item.items);
        menu.appendChild(sub);
        // To the right of the row; flip left at the viewport edge.
        sub.style.top = `${btn.offsetTop - 6}px`;
        const menuRect = menu.getBoundingClientRect();
        const subWidth = sub.getBoundingClientRect().width;
        if (menuRect.right + subWidth + 8 > window.innerWidth) {
          sub.style.right = "100%";
          sub.style.left = "auto";
        } else {
          sub.style.left = "100%";
          sub.style.right = "auto";
        }
      };
      btn.addEventListener("mouseenter", open);
      btn.addEventListener("click", open);
      menu.appendChild(btn);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "menu-row";
    btn.disabled = item.disabled === true;
    const label = document.createElement("span");
    label.textContent = item.label;
    if (item.strong === true) label.style.fontWeight = "600";
    btn.appendChild(label);
    if (item.hint !== undefined) {
      const hint = document.createElement("span");
      hint.className = "menu-hint";
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }
    btn.addEventListener("mouseenter", closeSubmenu);
    btn.addEventListener("click", () => {
      closeContextMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  }
}

export function showContextMenu(x: number, y: number, items: MenuItem[]) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "menu context-menu";
  buildItems(menu, items);

  document.body.appendChild(menu);
  current = menu;

  // Keep the menu inside the viewport.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  const dismiss = (e: Event) => {
    if (e instanceof MouseEvent && current?.contains(e.target as Node)) return;
    closeContextMenu();
    cleanup();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeContextMenu();
      cleanup();
    }
  };
  const cleanup = () => {
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("wheel", dismiss, true);
    window.removeEventListener("blur", dismiss);
    document.removeEventListener("keydown", onKey, true);
  };
  document.addEventListener("mousedown", dismiss, true);
  document.addEventListener("wheel", dismiss, true);
  window.addEventListener("blur", dismiss);
  document.addEventListener("keydown", onKey, true);
}
