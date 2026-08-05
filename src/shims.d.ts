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
    preview(
      content?: unknown,
      stylesheets?: unknown[],
      renderTo?: Element,
    ): Promise<unknown>;
  }
}
