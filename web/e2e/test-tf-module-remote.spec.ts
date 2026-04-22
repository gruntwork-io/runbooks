import { test, expect, deleteFilesIfPrompted, getFilesPanel } from "./fixtures";
import path from "path";
import { fileURLToPath } from "url";

/**
 * End-to-end tests for opening an OpenTofu/Terraform module.
 *
 * When `gruntbooks open <path-or-url>` is called with a TF module,
 * the CLI generates a gruntbook from a built-in template and serves it.
 * The generated gruntbook should render a TfModule variable form and
 * a TemplateInline preview without errors.
 */

// Use a repo-local test fixture to avoid depending on external repos.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TF_MODULE_PATH = path.resolve(__dirname, "../../testdata/test-fixtures/tf-modules/s3-bucket");

// Same fixture accessed via GitHub URL, using main branch.
const TF_MODULE_REMOTE_URL =
  "https://github.com/gruntwork-io/runbooks/tree/main/testdata/test-fixtures/tf-modules/s3-bucket";

test.describe("TF module (local)", () => {
  test("renders TfModule form and generates terragrunt.hcl after submit", async ({
    page,
    serveGruntbook,
    serverPort,
  }) => {
    await serveGruntbook(TF_MODULE_PATH);
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.getByTestId("gruntbook-content");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // The TfModule block should render and show the variable form
    const moduleBlock = page.getByTestId("module-vars");
    await expect(moduleBlock).toBeVisible({ timeout: 15_000 });

    // Before submitting, the TemplateInline should show a dependency
    // warning — not a render error — since its inputsId block hasn't
    // submitted values yet.
    const templateBlock = page.getByTestId("module-config");
    await expect(templateBlock).toBeVisible({ timeout: 5_000 });
    await expect(templateBlock.getByText("Waiting for inputs from")).toBeVisible({ timeout: 5_000 });

    // Fill in the required "Bucket Name" field and submit
    await moduleBlock.getByRole("textbox", { name: "Bucket Name" }).fill("my-test-bucket");
    await moduleBlock.getByRole("button", { name: "Submit" }).click();

    // After submit, the TemplateInline should render the terragrunt.hcl
    // preview with static template content and the user-provided input value.
    await expect(templateBlock).toContainText("find_in_parent_folders", { timeout: 5_000 });
    await expect(templateBlock).toContainText('bucket_name = "my-test-bucket"');

    // The generated file should appear in the file panel
    const generated = getFilesPanel(page, "generated");
    await expect(generated.getTreeItem("terragrunt.hcl")).toBeVisible({ timeout: 5_000 });
    await generated.getTreeItem("terragrunt.hcl").click();
    await expect(generated.getCodeFile("terragrunt.hcl")).toContainText('bucket_name = "my-test-bucket"');
  });
});

test.describe("TF module (remote)", () => {
  // Remote module download + parsing can take a while
  test.setTimeout(60_000);

  test("renders TfModule form and generates terragrunt.hcl after submit", async ({
    page,
    serveGruntbook,
    serverPort,
  }) => {
    await serveGruntbook(TF_MODULE_REMOTE_URL);
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.getByTestId("gruntbook-content");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    const moduleBlock = page.getByTestId("module-vars");
    await expect(moduleBlock).toBeVisible({ timeout: 15_000 });

    const templateBlock = page.getByTestId("module-config");
    await expect(templateBlock).toBeVisible({ timeout: 5_000 });
    await expect(templateBlock.getByText("Waiting for inputs from")).toBeVisible({ timeout: 5_000 });

    await moduleBlock.getByRole("textbox", { name: "Bucket Name" }).fill("my-test-bucket");
    await moduleBlock.getByRole("button", { name: "Submit" }).click();

    await expect(templateBlock).toContainText("find_in_parent_folders", { timeout: 5_000 });
    await expect(templateBlock).toContainText('bucket_name = "my-test-bucket"');

    const generated = getFilesPanel(page, "generated");
    await expect(generated.getTreeItem("terragrunt.hcl")).toBeVisible({ timeout: 5_000 });
    await generated.getTreeItem("terragrunt.hcl").click();
    await expect(generated.getCodeFile("terragrunt.hcl")).toContainText('bucket_name = "my-test-bucket"');
  });
});
