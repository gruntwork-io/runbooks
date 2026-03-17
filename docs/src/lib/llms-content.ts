// These are internal Starlight modules. We import via absolute path to bypass
// the package.json exports map, which doesn't expose utils publicly.
// @ts-ignore - internal Starlight module
import { getSidebar } from "../../node_modules/@astrojs/starlight/utils/navigation.ts";
// @ts-ignore - internal Starlight module
import { routes } from "../../node_modules/@astrojs/starlight/utils/routing/index.ts";

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

interface Route {
  slug: string;
  id: string;
  entry: {
    data: { title?: string };
    body?: string;
  };
}

/** Build a map from sidebar href to route entry for O(1) lookup. */
const routesByPath = new Map(routes.map((r) => [`/${r.slug}/`, r]));
// Also map the root route.
for (const r of routes) {
  if (r.slug === "") routesByPath.set("/", r);
}

/** Strip MDX/JSX syntax from raw markdown body to produce clean plaintext markdown. */
function stripMdx(body: string): string {
  let text = body;

  // Remove frontmatter
  text = text.replace(/^---[\s\S]*?---\n*/, "");

  // Remove import lines
  text = text.replace(/^import .*;\s*\n?/gm, "");

  // Convert <Aside type="X"> to blockquotes
  text = text.replace(
    /<Aside\s+type="(\w+)"(?:\s+title="([^"]*)")?>\s*/g,
    (_match, type: string, title?: string) => {
      const label = title || type.charAt(0).toUpperCase() + type.slice(1);
      return `> **${label}:** `;
    },
  );
  text = text.replace(/<\/Aside>\s*/g, "\n\n");

  // Convert :::note[label] admonition syntax to blockquotes
  text = text.replace(/^:::(\w+)\[([^\]]*)\]\s*$/gm, "> **$2:**");
  text = text.replace(/^:::(\w+)\s*$/gm, (_match, type: string) => {
    return `> **${type.charAt(0).toUpperCase() + type.slice(1)}:**`;
  });
  text = text.replace(/^:::\s*$/gm, "");

  // Convert <Tabs>/<TabItem> to labeled sections
  text = text.replace(/<Tabs>\s*/g, "");
  text = text.replace(/<\/Tabs>\s*/g, "");
  text = text.replace(/<TabItem\s+label="([^"]*)">\s*/g, "#### $1\n\n");
  text = text.replace(/<\/TabItem>\s*/g, "\n");

  // Convert <Steps> wrapper (just strip the tags)
  text = text.replace(/<\/?Steps>\s*/g, "");

  // Convert <Card title="X"> to bold heading
  text = text.replace(/<Card\s+title="([^"]*)"[^>]*>\s*/g, "**$1**\n\n");
  text = text.replace(/<\/Card>\s*/g, "\n");

  // Strip <CardGrid>, <FileTree>, <Icon> tags
  text = text.replace(/<\/?CardGrid>\s*/g, "");
  text = text.replace(/<\/?FileTree>\s*/g, "");
  text = text.replace(/<Icon\s+[^/]*\/>\s*/g, "");

  // Strip <SourceFile> tags (the embedded file content isn't available as raw text)
  text = text.replace(/<SourceFile\s+[^/]*\/>\s*/g, "[See source file in repository]\n\n");

  // Strip any remaining self-closing JSX tags like <Component ... />
  text = text.replace(/<[A-Z][a-zA-Z]*\s+[^>]*\/>\s*/g, "");

  // Strip remaining opening/closing JSX component tags (preserve inner content)
  text = text.replace(/<\/?[A-Z][a-zA-Z]*[^>]*>\s*/g, "");

  // Clean up excessive blank lines (3+ -> 2)
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Walk the sidebar tree and emit text for each entry.
 * Groups become section headings, links become doc content.
 */
function walkSidebar(entries: SidebarEntry[], parts: string[], depth: number): void {
  for (const entry of entries) {
    if (entry.type === "group") {
      // Use markdown heading based on depth (## for top-level groups, ### for nested).
      const heading = "#".repeat(Math.min(depth + 2, 4));
      parts.push(`${heading} ${entry.label}`, "");
      walkSidebar(entry.entries, parts, depth + 1);
    } else {
      const route = routesByPath.get(entry.href);
      if (!route) continue;

      // Skip the homepage — it's a splash page.
      if (route.slug === "") continue;

      const title = route.entry.data.title || route.id;
      const heading = "#".repeat(Math.min(depth + 2, 4));
      parts.push(`${heading} ${title}`, "");

      if (route.entry.body) {
        parts.push(stripMdx(route.entry.body), "");
      }

      parts.push("---", "");
    }
  }
}

export async function generateLlmsTxt(): Promise<string> {
  // Get the fully resolved sidebar in the exact order Starlight uses.
  const sidebar = getSidebar("/", undefined);

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
    "---",
    "",
  ];

  walkSidebar(sidebar, parts, 0);

  return parts.join("\n");
}
