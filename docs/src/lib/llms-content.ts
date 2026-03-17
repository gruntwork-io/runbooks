import { getCollection } from "astro:content";

const DOC_ORDER = [
  {
    section: "Intro",
    entries: [
      "intro/overview",
      "intro/ui_tour",
      "intro/installation",
      "intro/write_your_first_runbook",
      "intro/use_cases",
      "intro/runbooks_vs_other",
      "intro/files_workspace",
    ],
  },
  {
    section: "CLI",
    entries: [
      "commands/overview",
      "commands/open",
      "commands/serve",
      "commands/watch",
    ],
  },
  {
    section: "Authoring Runbooks",
    entries: [
      "authoring/overview",
      "authoring/runbook-structure",
      "authoring/markdown",
      "authoring/inputs-and-outputs",
      "authoring/opening-runbooks",
      "authoring/boilerplate",
      "authoring/testing",
      "authoring/blocks",
      "authoring/blocks/inputs",
      "authoring/blocks/command",
      "authoring/blocks/check",
      "authoring/blocks/template",
      "authoring/blocks/templateinline",
      "authoring/blocks/awsauth",
      "authoring/blocks/githubauth",
      "authoring/blocks/gitclone",
      "authoring/blocks/githubpullrequest",
      "authoring/blocks/dirpicker",
      "authoring/blocks/tfmodule",
      "authoring/blocks/admonition",
      "authoring/blocks/advanced",
    ],
  },
  {
    section: "Security",
    entries: [
      "security/execution-model",
      "security/shell-execution-context",
      "security/telemetry",
    ],
  },
  {
    section: "Development",
    entries: ["development/workflow"],
  },
  {
    section: "Runbooks Pro",
    entries: ["pro/overview"],
  },
];

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

export async function generateLlmsTxt(): Promise<string> {
  const allDocs = await getCollection("docs");
  const docMap = new Map(allDocs.map((doc) => [doc.id, doc]));

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

  for (const section of DOC_ORDER) {
    parts.push(`## ${section.section}`, "");

    for (const entryId of section.entries) {
      const doc = docMap.get(entryId);
      if (!doc) {
        console.warn(`[llms.txt] Entry not found: ${entryId}`);
        continue;
      }

      const title = doc.data.title || entryId;
      parts.push(`### ${title}`, "");

      if (doc.body) {
        parts.push(stripMdx(doc.body), "");
      }

      parts.push("---", "");
    }
  }

  return parts.join("\n");
}
