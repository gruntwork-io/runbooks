import { test, expect, expectNoConsoleErrors, trustRunbook, deleteFilesIfPrompted, getFilesPanel } from "./fixtures";

/**
 * End-to-end tests for the sample runbooks in testdata/sample-runbooks/.
 *
 * Each test starts a fresh server, loads the runbook in a real browser, and
 * verifies the MDX content renders correctly and interactive blocks function.
 */

// ---------------------------------------------------------------------------
// Test: demo1
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/demo1", () => {
  test("renders demo1 without errors", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/demo1");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Verify the title rendered.
    await expect(page.locator("h1")).toHaveText("Welcome to the Gruntwork AWS Accelerator!");

    // Verify the architecture image loaded successfully.
    const img = page.getByRole("img", { name: "AWS infrastructure preview" });
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth);
    expect(naturalWidth, "Image failed to load (naturalWidth is 0)").toBeGreaterThan(0);

    // Verify key sections rendered.
    await expect(page.getByRole("heading", { name: "Three foundational git repos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Individual team repos" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Next steps" })).toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: demo2
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/demo2", () => {
  test("renders demo2 without errors", async ({ page, serveRunbook, serverPort }) => {
    await serveRunbook("testdata/sample-runbooks/demo2");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    // Verify the title rendered.
    await expect(page.locator('h1')).toContainText('Create the infrastructure-live-root repo');

    // Check that gh is installed
    const ghCheck = page.getByTestId('check-gh-install');
    await ghCheck.getByRole('button', { name: 'Check' }).click();
    await expect(ghCheck.getByTestId('icon-success')).toBeVisible({ timeout: 5_000 });

    // Fill in the GitHub Org Name
    const createRepoBlock = page.getByTestId('create-infrastructure-live-root-repo');
    await createRepoBlock.getByRole('textbox', { name: 'GitHub Org Name*' }).fill('gruntwork-io');
    await expect(createRepoBlock.getByRole('button', { name: 'Run' })).toBeEnabled();

    const generated = getFilesPanel(page, 'generated');
    await expect(generated.getTreeItem('ci.yml')).not.toBeVisible();

    // Fill in the OpenTofu and Terragrunt Versions
    const lookupVersionsBlock = page.getByTestId('mise-config-inputs');
    await lookupVersionsBlock.getByRole('textbox', { name: 'OpenTofu Version' }).fill('1');
    await lookupVersionsBlock.getByRole('textbox', { name: 'Terragrunt Version*' }).fill('2');
    await lookupVersionsBlock.getByRole('button', { name: 'Generate' }).first().click();
    
    await expect(generated.getCodeFile('.mise.toml')).toContainText('opentofu = "1"');
    await expect(generated.getCodeFile('.mise.toml')).toContainText('terragrunt = "2"');

    // TemplateInline block should render the CI workflow preview (generateFile=false)
    // TODO: uncomment once TemplateInline has an `id` prop (see branch adding id to TemplateInline)
    // const ciBlock = page.getByTestId('ci-workflow-preview');
    // await expect(ciBlock.getByText('ci.yml')).toBeVisible();
    // await expect(ciBlock.getByRole('code').filter({ hasText: 'name: CI' })).toBeVisible();
    // await expect(generated.getTreeItem('ci.yml')).not.toBeVisible();

    // Fill in the Org Name Prefix and confirm that files are generated
    const infraLiveElements = page.getByTestId('infra-live-elements-inputs');
    await infraLiveElements.getByRole('textbox', { name: 'Org Name Prefix' }).fill('my_prefix');
    await infraLiveElements.getByRole('button', { name: 'Generate', exact: true }).click();
    await expect(generated.getTreeItem('subfolder')).toBeVisible({ timeout: 2_000 });
    await generated.getTreeItem('subfolder').click();
    await expect(generated.getTreeItem('sample.hcl')).toBeVisible({ timeout: 2_000 });
    await generated.getTreeItem('sample.hcl').click();
    await expect(generated.getCodeFile('subfolder/sample.hcl')).toContainText('name_prefix = "my_prefix"');
  });

  test("renders the large input form and generates files", async ({ page, serveRunbook, serverPort }) => {
    await serveRunbook("testdata/sample-runbooks/demo2");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const infraLiveForm = page.getByTestId('infra-live-elements-inputs');
    await expect(infraLiveForm).toBeVisible({ timeout: 5_000 });

    // Verify all input types render.
    await expect(infraLiveForm.getByRole('textbox', { name: 'Org Name Prefix' })).toBeVisible();
    await expect(infraLiveForm.getByRole('combobox', { name: 'Default Region' })).toBeVisible();
    await expect(infraLiveForm.getByRole('textbox', { name: 'Root Terragrunt File Name' })).toBeVisible();
    await expect(infraLiveForm.getByRole('checkbox', { name: 'Add Additional Common Variables' })).toBeVisible();
    await expect(infraLiveForm.getByRole('textbox', { name: 'Catalog Tags' })).toBeVisible();

    // Fill in the string inputs.
    await infraLiveForm.getByRole('textbox', { name: 'Org Name Prefix' }).fill('acme');
    await infraLiveForm.getByRole('textbox', { name: 'Root Terragrunt File Name' }).clear();
    await infraLiveForm.getByRole('textbox', { name: 'Root Terragrunt File Name' }).fill('terragrunt2.hcl');

    // Select an enum value.
    await infraLiveForm.getByRole('combobox', { name: 'Default Region' }).selectOption('eu-west-1');

    // Ensure the bool checkbox is checked (default is true).
    await expect(infraLiveForm.getByRole('checkbox', { name: 'Add Additional Common Variables' })).toBeChecked();

    // Add a structured map entry (AWSAccounts with x-schema).
    const awsField = infraLiveForm.getByTestId('field-AWSAccounts');
    await awsField.getByRole('button', { name: 'Add' }).click();
    await awsField.getByRole('textbox', { name: /AWS Account Name/ }).fill('dev-account');
    await awsField.getByRole('textbox', { name: /^email\b/i }).fill('dev@example.com');
    await awsField.getByRole('textbox', { name: /^environment\b/i }).fill('development');
    await awsField.getByRole('textbox', { name: /^id\b/i }).fill('111222333444');
    await awsField.getByRole('button', { name: 'Save Entry' }).click();

    // Submit the form and verify files are generated.
    await infraLiveForm.getByRole('button', { name: 'Generate', exact: true }).click();

    const genFiles = getFilesPanel(page, 'generated');

    // Verify common.hcl contains values from our inputs.
    await expect(genFiles.getTreeItem('common.hcl')).toBeVisible({ timeout: 2_000 });
    await genFiles.getTreeItem('common.hcl').click();
    await expect(genFiles.getCodeFile('common.hcl')).toContainText('name_prefix    = "acme"');
    await expect(genFiles.getCodeFile('common.hcl')).toContainText('default_region = "eu-west-1"');
    await expect(genFiles.getCodeFile('common.hcl')).toContainText('config_s3_bucket_name');

    // Verify accounts.yml contains the structured map entry.
    await expect(genFiles.getTreeItem('accounts.yml')).toBeVisible({ timeout: 2_000 });
    await genFiles.getTreeItem('accounts.yml').click();
    await expect(genFiles.getCodeFile('accounts.yml')).toContainText('dev-account');
    await expect(genFiles.getCodeFile('accounts.yml')).toContainText('111222333444');

    // Verify the root terragrunt file uses our custom name.
    await expect(genFiles.getTreeItem('terragrunt2.hcl')).toBeVisible({ timeout: 2_000 });
    await genFiles.getTreeItem('terragrunt2.hcl').click();
  });
});

// ---------------------------------------------------------------------------
// Test: demo3
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/demo3", () => {
  test("renders all blocks without errors", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/demo3");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Verify the title rendered.
    await expect(page.locator("h1")).toHaveText("Demo Runbook 3");

    // Verify the Inputs block (test2) rendered its form with defaults.
    const inputsBlock = page.getByTestId("test2");
    await expect(inputsBlock).toBeVisible();
    await expect(inputsBlock.getByRole("textbox", { name: /GitHub Org Name/i })).toHaveValue("gruntwork-io");
    await expect(inputsBlock.getByRole("textbox", { name: /GitHub Repo Name/i })).toHaveValue("runbooks-infrastructure-live-example");

    // Verify the Command block (test6) rendered with embedded inputs.
    const commandBlock = page.getByTestId("test6-command");
    await expect(commandBlock).toBeVisible();
    await expect(commandBlock.getByText("Test embedded inputs")).toBeVisible();
    await expect(commandBlock.getByRole("textbox", { name: /project/i })).toHaveValue("my-awesome-project");
    await expect(commandBlock.getByRole("textbox", { name: /author/i })).toHaveValue("Developer");

    // Wait for templates to auto-render (they fire after a debounce).
    await page.waitForTimeout(2_000);

    // No template rendering errors should be visible.
    await expect(page.getByTestId("component-error")).not.toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });

  test("runs a command with embedded inputs and shows success", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/demo3");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    await trustRunbook(page);

    // Find the Command block (test6) and click Run with default embedded inputs.
    const commandBlock = page.getByTestId("test6-command");
    await commandBlock.getByRole("button", { name: "Run" }).click();

    // Verify the success icon appears.
    await expect(commandBlock.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 });

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });

  test("generates files from Template block and shows them in file panel", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/demo3");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // The Template block (test1) loads from templates/infra-live-elements.
    // Verify it rendered a form and generates files into the file panel.
    const templateBlock = page.getByTestId("test1");
    await expect(templateBlock).toBeVisible();
    await expect(templateBlock.getByRole("button", { name: "Generate" })).toBeVisible();

    // Click Generate and verify files appear in the generated panel.
    await templateBlock.getByRole("button", { name: "Generate" }).click();
    const generated = getFilesPanel(page, "generated");
    await expect(generated.getTreeItem("common.hcl")).toBeVisible({ timeout: 5_000 });

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: markdown-only-full
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/markdown-only-full", () => {
  test("renders all markdown elements correctly", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/markdown-only-full");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 5_000 });

    // Verify the title rendered.
    await expect(page.locator("h1")).toHaveText("Markdown Examples");

    // Verify heading levels 2–6 are all present.
    await expect(page.getByRole("heading", { name: "Headers" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 3 Header" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 4 Header" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 5 Header" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 6 Header" })).toBeVisible();

    // Verify text formatting.
    await expect(markdownBody.locator("strong").filter({ hasText: "Bold text" })).toBeVisible();
    await expect(markdownBody.locator("del").filter({ hasText: "Strikethrough text" })).toBeVisible();
    await expect(markdownBody.locator("code").filter({ hasText: "Inline code" })).toBeVisible();

    // Verify code blocks rendered (Go and Python).
    await expect(markdownBody.getByText('fmt.Println("Hello, World!")')).toBeVisible();
    await expect(markdownBody.getByText('print("Hello, World!")')).toBeVisible();

    // Verify the table rendered with content.
    await expect(page.getByRole("heading", { name: "Tables" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Column 1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Data 6" })).toBeVisible();

    // Verify the image loaded successfully.
    const img = markdownBody.locator("img");
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth);
    expect(naturalWidth, "Image failed to load (naturalWidth is 0)").toBeGreaterThan(0);

    // Verify the link rendered.
    await expect(markdownBody.getByRole("link", { name: "Link to Google" })).toBeVisible();

    // Verify blockquote rendered.
    const blockquote = markdownBody.locator("blockquote");
    await expect(blockquote.first()).toBeVisible();
    await expect(blockquote.first().getByText("This is a blockquote.")).toBeVisible();

    // Verify task list checkboxes rendered.
    await expect(page.getByRole("heading", { name: "Task Lists" })).toBeVisible();
    const checkboxes = markdownBody.getByRole("checkbox");
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount, "Expected at least 4 task list checkboxes").toBeGreaterThanOrEqual(4);

    // Verify the horizontal rule rendered.
    const hrElements = markdownBody.locator("hr");
    const hrCount = await hrElements.count();
    expect(hrCount).toBeGreaterThanOrEqual(1);

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: my-first-runbook
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/my-first-runbook", () => {
  test("renders MDX content with all block types", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/my-first-runbook");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Verify the title.
    await expect(page.locator("h1")).toHaveText("My First Runbook");

    // Verify all major sections rendered.
    await expect(page.getByRole("heading", { name: "Full markdown support" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Admonitions" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Checks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Generate files" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Run commands" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Congratulations!" })).toBeVisible();

    // Verify the markdown table in "Full markdown support" section.
    await expect(page.getByRole("cell", { name: "Headings" })).toBeVisible();

    // Verify both Check blocks rendered with their buttons.
    const gitCheck = page.getByTestId("check-git");
    await expect(gitCheck).toBeVisible();
    await expect(gitCheck.getByRole("button", { name: "Check" })).toBeVisible();

    const gitVersionCheck = page.getByTestId("check-git-version");
    await expect(gitVersionCheck).toBeVisible();
    await expect(gitVersionCheck.getByText("Check Git Version")).toBeVisible();
    await expect(gitVersionCheck.getByRole("textbox", { name: /git version/i })).toHaveValue("2.39.0");

    // Verify the Template block rendered a form with defaults.
    const templateBlock = page.getByTestId("project");
    await expect(templateBlock).toBeVisible();
    await expect(templateBlock.getByRole("textbox", { name: /project/i })).toHaveValue("my-awesome-project");
    await expect(templateBlock.getByRole("combobox", { name: /language/i })).toHaveValue("Go");

    // Verify both Command blocks rendered.
    const setupCmd = page.getByTestId("run-setup");
    await expect(setupCmd).toBeVisible();
    await expect(setupCmd.getByText("Run Project Setup")).toBeVisible();

    const finalCmd = page.getByTestId("final-message");
    await expect(finalCmd).toBeVisible();
    await expect(finalCmd.getByText("Show Success Message")).toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });

  test("generates template files and shows them in the file panel", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/my-first-runbook");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Fill in the Template form and generate files.
    const templateBlock = page.getByTestId("project");
    await templateBlock.getByRole("textbox", { name: /project/i }).clear();
    await templateBlock.getByRole("textbox", { name: /project/i }).fill("test-project");
    await templateBlock.getByRole("textbox", { name: "Author" }).fill("Alice");
    await templateBlock.getByRole("button", { name: "Generate" }).click();

    // Verify files appear in the generated file panel.
    const generated = getFilesPanel(page, "generated");
    await expect(generated.getTreeItem("README.md")).toBeVisible({ timeout: 5_000 });

    // Verify the generated README contains our input values.
    await generated.getTreeItem("README.md").click();
    await expect(generated.getCodeFile("README.md")).toContainText("test-project");
    await expect(generated.getCodeFile("README.md")).toContainText("Alice");

    expectNoConsoleErrors(consoleMessages);
  });
});

// ---------------------------------------------------------------------------
// Test: homepage-demo
// ---------------------------------------------------------------------------
test.describe("sample-runbooks/homepage-demo", () => {
  test("renders without errors", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/homepage-demo");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    // Verify the title rendered.
    await expect(page.locator("h1")).toHaveText("Deploy a New Service");

    // Verify key sections rendered.
    await expect(page.getByRole("heading", { name: "Pre-flight checks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Configure your service" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deploy", exact: true })).toBeVisible();

    // Verify the Check block rendered with a Check button.
    const checkBlock = page.getByTestId("check-node");
    await expect(checkBlock).toBeVisible();
    await expect(checkBlock.getByRole("button", { name: "Check" })).toBeVisible();

    // Verify the Inputs block rendered with defaults.
    const inputsBlock = page.getByTestId("service-config");
    await expect(inputsBlock).toBeVisible();
    await expect(inputsBlock.getByRole("textbox", { name: /Service Name/i })).toHaveValue("my-service");
    await expect(inputsBlock.getByRole("combobox", { name: /Environment/i })).toHaveValue("dev");
    await expect(inputsBlock.getByRole("checkbox", { name: /Enable Monitoring/i })).toBeChecked();

    // Verify the Command block rendered with a Run button.
    const commandBlock = page.getByTestId("deploy");
    await expect(commandBlock).toBeVisible();
    await expect(commandBlock.getByRole("button", { name: "Run" })).toBeVisible();

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });

  test("runs check and command blocks", async ({ page, serveRunbook, serverPort, consoleMessages }) => {
    await serveRunbook("testdata/sample-runbooks/homepage-demo");
    await page.goto(`http://localhost:${serverPort}/`);
    await deleteFilesIfPrompted(page);

    const markdownBody = page.locator(".markdown-body");
    await expect(markdownBody).toBeVisible({ timeout: 15_000 });

    await trustRunbook(page);

    // Run the Check block and verify success.
    const checkBlock = page.getByTestId("check-node");
    await checkBlock.getByRole("button", { name: "Check" }).click();
    await expect(checkBlock.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 });

    // Submit the inputs so the Command block becomes enabled.
    const inputsBlock = page.getByTestId("service-config");
    await inputsBlock.getByRole("button", { name: "Submit" }).click();

    // Run the Command block and verify success.
    const commandBlock = page.getByTestId("deploy");
    await expect(commandBlock.getByRole("button", { name: "Run" })).toBeEnabled({ timeout: 10_000 });
    await commandBlock.getByRole("button", { name: "Run" }).click();
    await expect(commandBlock.getByTestId("icon-success")).toBeVisible({ timeout: 15_000 });

    // No error boundary should be visible.
    await expect(page.getByTestId("mdx-error")).not.toBeVisible();

    expectNoConsoleErrors(consoleMessages);
  });
});

