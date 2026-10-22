import fs from "node:fs";
import path from "node:path";
// These are internal Starlight modules. We import via a relative path to bypass
// the package.json exports map, which doesn't expose utils publicly. Since
// Starlight 0.42 the package ships compiled JavaScript with type declarations
// under dist/ (no more TypeScript sources), so these paths track that layout.
import { getSidebar } from "../../node_modules/@astrojs/starlight/dist/utils/navigation.js";
import { routes } from "../../node_modules/@astrojs/starlight/dist/utils/routing/index.js";
import { slugToPathname } from "../../node_modules/@astrojs/starlight/dist/utils/slugs.js";

interface SidebarLink {
  type: "link";
  label: string;
  href: string;
}
interface SidebarGroup {
  type: "group";
  label: string;
  entries: SidebarEntry[];
}
type SidebarEntry = SidebarLink | SidebarGroup;

type Route = (typeof routes)[number];

/** A page to include, with the sidebar groups it sits in. */
interface Page {
  route: Route;
  trail: string[];
}

// Build a map from sidebar href to route entry for O(1) lookup. Sidebar links
// carry an href that is a pathname (e.g. "/intro/overview/"), so we key on the
// same pathname Starlight derives from each route. Note: a route exposes its
// slug as `id` (this was `slug` before Starlight 0.39), and slugToPathname maps
// the root route ("") to "/" for us.
const routesByPath = new Map(routes.map((r) => [slugToPathname(r.id), r]));

// <SourceFile> paths are relative to the repo root, one level above the docs
// project. SourceFile.astro resolves them the same way.
const repoRoot = path.resolve(process.cwd(), "..");

/** The opening or closing line of a fenced code block, such as "```mdx". */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** An inline code span: a run of backticks, then text, then a run of the same length. */
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)(.*?)(?<!`)\1(?!`)/g;

/** An MDX component tag that MDX didn't see escaped, as `\<Inputs\>` is. */
const COMPONENT_TAG_RE = /(?<!\\)<\/?([A-Z][A-Za-z]*)/;

/** Applies `fn` to the parts of a prose line outside its inline code spans. */
function outsideInlineCode(line: string, fn: (text: string) => string): string {
  let result = "";
  let last = 0;
  for (const match of line.matchAll(INLINE_CODE_RE)) {
    result += fn(line.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + fn(line.slice(last));
}

/** A fence one backtick longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Convert a page's raw MD/MDX body to plain markdown.
 *
 * Fenced code blocks, which hold the docs' block examples, are copied as they
 * are. In prose, the Starlight components the docs use become markdown, and
 * MDX escapes such as `\<Inputs\>` are undone. Any other component is an error
 * rather than being stripped, since its content would go missing from
 * llms.txt without anyone noticing.
 */
function toMarkdown(body: string, pageId: string): string {
  const out: string[] = [];
  // The fence of the code block being copied, if any
  let fence: string | undefined;
  // The <Aside>s, ::: directives and <TabItem>s the line is in, innermost
  // last. An Aside or directive is a blockquote. `indent` is how far the
  // content is indented under its tag, measured on its first line.
  const containers: { quote: boolean; indent?: number }[] = [];
  // The level of the last heading, which a tab label's heading goes under
  let headingLevel = 1;

  const emit = (line: string) => {
    const quoteDepth = containers.filter((container) => container.quote).length;
    if (quoteDepth > 0) line = line === "" ? ">" : `${"> ".repeat(quoteDepth)}${line}`;
    // Keep at most one blank line between blocks of prose
    if (line === "" && !fence && out.at(-1) === "") return;
    out.push(line);
  };
  const closeContainer = () => {
    // A blank line ends the blockquote
    if (containers.pop()?.quote) out.push("");
  };

  for (let line of body.split("\n")) {
    for (const container of containers) {
      const indent = line.length - line.trimStart().length;
      if (container.indent === undefined && line.trim() !== "") container.indent = indent;
      line = line.slice(Math.min(indent, container.indent ?? 0));
    }

    if (fence) {
      emit(line);
      const closing = FENCE_RE.exec(line);
      if (
        closing &&
        closing[1][0] === fence[0] &&
        closing[1].length >= fence.length &&
        line.trim() === closing[1]
      ) {
        fence = undefined;
      }
      continue;
    }
    const opening = FENCE_RE.exec(line);
    if (opening) {
      fence = opening[1];
      emit(line);
      continue;
    }

    const trimmed = line.trim();

    if (/^import\s.+\sfrom\s+["'][^"']+["'];?$/.test(trimmed)) continue;

    const aside =
      /^<Aside(?:\s+type="(\w+)")?(?:\s+title="([^"]*)")?\s*>$/.exec(trimmed) ??
      /^:::(\w+)(?:\[([^\]]*)\])?$/.exec(trimmed);
    if (aside) {
      const type = aside[1] ?? "note";
      containers.push({ quote: true });
      emit(`**${aside[2] || type.charAt(0).toUpperCase() + type.slice(1)}:**`);
      continue;
    }

    const tabItem = /^<TabItem\s+label="([^"]*)"\s*>$/.exec(trimmed);
    if (tabItem) {
      emit(`${"#".repeat(Math.min(headingLevel + 1, 6))} ${tabItem[1]}`);
      emit("");
      containers.push({ quote: false });
      continue;
    }

    if (trimmed === "</Aside>" || trimmed === ":::" || trimmed === "</TabItem>") {
      closeContainer();
      continue;
    }

    // Wrappers whose content is already markdown: a numbered list for
    // <Steps>, a bulleted list for <FileTree>
    if (/^<\/?(Tabs|Steps|FileTree)>$/.test(trimmed)) continue;

    // <SourceFile> shows a repo file, so copy that file into a code block
    const sourceFile = /^<SourceFile\s+(.*?)\s*\/>$/.exec(trimmed);
    if (sourceFile) {
      const attrs = new Map(
        [...sourceFile[1].matchAll(/(\w+)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? ""]),
      );
      const file = attrs.get("file");
      if (!file) throw new Error(`llms.txt: a <SourceFile> in ${pageId} has no file`);
      const content = fs.readFileSync(path.resolve(repoRoot, file), "utf-8").trimEnd();
      const indent = line.slice(0, line.length - line.trimStart().length);
      if (!attrs.has("hideTitle")) {
        emit(`${indent}**\`${attrs.get("title") || path.basename(file)}\`**`);
        emit("");
      }
      // Emit the file as a code block, so it's copied as is
      fence = fenceFor(content);
      emit(`${indent}${fence}${attrs.get("lang") ?? ""}`);
      for (const fileLine of content.split("\n")) emit(fileLine === "" ? "" : indent + fileLine);
      emit(`${indent}${fence}`);
      fence = undefined;
      continue;
    }

    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) headingLevel = heading[1].length;

    emit(
      outsideInlineCode(line, (text) => {
        const tag = COMPONENT_TAG_RE.exec(text);
        if (tag) {
          throw new Error(
            `llms.txt: ${pageId} uses <${tag[1]}>, which docs/src/lib/llms-content.ts ` +
              `doesn't convert to markdown. Teach toMarkdown() to convert it.`,
          );
        }
        return text.replace(/\\([<>{}])/g, "$1");
      }),
    );
  }

  while (containers.length > 0) closeContainer();
  return out.join("\n").trim();
}

/** Collect the sidebar's pages in the exact order Starlight shows them. */
function collectPages(entries: SidebarEntry[], trail: string[], pages: Page[]): void {
  for (const entry of entries) {
    if (entry.type === "group") {
      collectPages(entry.entries, [...trail, entry.label], pages);
    } else {
      const route = routesByPath.get(entry.href);
      // Skip external links and the homepage, which is a splash page
      if (route && route.id !== "") pages.push({ route, trail });
    }
  }
}

/** A page's heading: the sidebar groups it sits in, then its title. */
function pageHeading({ route, trail }: Page): string {
  return [...trail, route.entry.data.title || route.id].join(" › ");
}

export async function generateLlmsTxt(): Promise<string> {
  // Get the fully resolved sidebar in the exact order Starlight uses.
  const sidebar = getSidebar("/", undefined);
  const pages: Page[] = [];
  collectPages(sidebar, [], pages);

  // A page the sidebar doesn't link to still belongs in the docs an LLM reads.
  const included = new Set(pages.map((page) => page.route.id));
  for (const route of routes) {
    if (route.id !== "" && !included.has(route.id)) pages.push({ route, trail: [] });
  }

  const parts: string[] = [
    "# Gruntwork Runbooks Documentation",
    "",
    "> Gruntwork Runbooks turns your infrastructure expertise into guided",
    "> workflows that any developer can safely execute.",
    ">",
    "> This document contains the full documentation for authoring and using Runbooks.",
    "> Paste it into your LLM for complete context when writing runbooks.",
    "",
    "Source: https://runbooks.gruntwork.io",
    "",
    "Each page below starts with a top-level heading naming its place in the docs.",
    "",
    "## Contents",
    "",
    ...pages.map((page) => `- ${pageHeading(page)}`),
    "",
    "---",
    "",
  ];

  for (const page of pages) {
    parts.push(`# ${pageHeading(page)}`, "");
    if (page.route.entry.body) {
      parts.push(toMarkdown(page.route.entry.body, page.route.id), "");
    }
    parts.push("---", "");
  }

  return parts.join("\n");
}
