declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, options?: { enabled?: boolean }) => void;
  export default plugin;
}

declare module "markdown-it-sub" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-sup" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: (service: TurndownService) => void;
}

declare module "pagedjs" {
  export class Previewer {
    constructor(options?: unknown);
    polisher: { destroy(): void };
    // Each rendered page keeps a ResizeObserver alive (for reflow-triggered
    // re-pagination) until Chunker#removePages() runs Page#destroy() on it.
    // Clearing a preview container's DOM without calling this first leaves
    // that observer attached to now-removed nodes — see the teardownPreview
    // helper in main.ts.
    chunker: { removePages(): void };
    preview(
      content?: unknown,
      stylesheets?: unknown[],
      renderTo?: Element,
    ): Promise<unknown>;
  }
}
