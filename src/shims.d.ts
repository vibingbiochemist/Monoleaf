declare module "*?raw" {
  const content: string;
  export default content;
}

// Vite's explicit-URL asset suffix (see src/fontEmbeds.ts) — resolves to the
// built, hashed asset path as a plain string.
declare module "*?url" {
  const url: string;
  export default url;
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
  export interface PagedBreakToken {
    node: Node;
    offset: number;
  }
  export interface PagedPage {
    position: number; // 0-based
  }
  export interface PagedHook<A extends unknown[]> {
    register(...handlers: Array<(...args: A) => unknown>): void;
  }
  export class Previewer {
    constructor(options?: unknown);
    polisher: { destroy(): void };
    // Each rendered page keeps a ResizeObserver alive (for reflow-triggered
    // re-pagination) until Chunker#removePages() runs Page#destroy() on it.
    // Clearing a preview container's DOM without calling this first leaves
    // that observer attached to now-removed nodes — see the teardownPreview
    // helper in main.ts.
    chunker: {
      removePages(): void;
      hooks: {
        // Fires once per page laid out, with the exact break token (source
        // DOM node + character offset) the layout stopped at — undefined
        // for the last page / pages with nothing left to break. See the
        // resolveExactBreakPos design note in pagination.ts.
        afterPageLayout: PagedHook<
          [HTMLElement, PagedPage, PagedBreakToken | undefined, unknown]
        >;
      };
    };
    preview(
      content?: unknown,
      stylesheets?: unknown[],
      renderTo?: Element,
    ): Promise<unknown>;
  }
}
