import { test, expect, deleteFilesIfPrompted, getFilesPanel } from "./fixtures";

/**
 * End-to-end test for opening a remote OpenTofu/Terraform module.
 *
 * When `runbooks open <github-url>` is called with a TF module URL,
 * the CLI downloads the module, generates a runbook from a built-in
 * template, and serves it. The generated runbook should render a
 * TfModule variable form and a TemplateInline preview without errors.
 */

const REMOTE_TF_MODULE_URL =
  "https://github.com/gruntwork-io/terragrunt-scale-catalog/tree/main/modules/aws/s3-bucket";

test.describe("remote TF module", () => {
  // Remote module download + parsing can take a while
  test.setTimeout(60_000);

  test("renders TfModule form and generates terragrunt.hcl after submit", async ({
    page,
    serveRunbook,
    serverPort,
  }) => {
    await serveRunbook(REMOTE_TF_MODULE_URL);
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.getByTestId("runbook-content");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // The TfModule block should render and show the variable form
    const moduleBlock = page.getByTestId("module-vars");
    await expect(moduleBlock).toBeVisible({ timeout: 15_000 });

    // Fill in the required "Name" field and submit
    await moduleBlock.getByRole("textbox", { name: "Name" }).fill("my-test-bucket");
    await moduleBlock.getByRole("button", { name: "Submit" }).click();

    // The TemplateInline should render the terragrunt.hcl preview with
    // static template content and the user-provided input value.
    const templateBlock = page.getByTestId("module-config");
    await expect(templateBlock).toContainText("find_in_parent_folders", { timeout: 5_000 });
    await expect(templateBlock).toContainText('name = "my-test-bucket"');

    // The generated file should appear in the file panel
    const generated = getFilesPanel(page, "generated");
    await expect(generated.getTreeItem("terragrunt.hcl")).toBeVisible({ timeout: 5_000 });
    await generated.getTreeItem("terragrunt.hcl").click();
    await expect(generated.getCodeFile("terragrunt.hcl")).toContainText('name = "my-test-bucket"');
  });
});
