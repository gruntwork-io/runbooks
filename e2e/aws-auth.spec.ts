/**
 * AwsAuth in the window, end to end: AwsAuth's test runbooks
 * (blocks/aws-auth/testdata) opened in place, signed in as a person signs
 * in, in the app's dev mode (RUNBOOKS_FAKE_CREDENTIALS=1,
 * packages/app-main/src/engine.ts). Its blocks sign in against the fake AWS
 * provider (blocks/aws-auth/fake.ts), in memory: nothing starts a plugin
 * binary or contacts AWS.
 *
 * A secret access key typed into the Static Credentials tab signs the block
 * in and reaches the run of a block that names it in `envFrom`; a wrong
 * one is refused. Neither is in a message main sends the window, in the
 * page, in what main writes to its output, or in a file the app leaves in
 * its user data folder.
 *
 * The old app's AwsAuth checks run on the `sign-in` runbook:
 * electron/e2e/kitchen-sink.spec.ts ("AwsAuth block renders", "AwsAuth
 * block has no errors") and electron/e2e/long-paths.spec.ts's AwsAuth (a
 * long description wraps inside its block). These don't apply:
 * electron/e2e/iframe.spec.ts types into "a field in the runbook, like an
 * AwsAuth secret key field", which it makes itself, to test an iframe's
 * focus; it is the iframe block's check. kitchen-sink.spec.ts's list of
 * block ids it finds on the page is the kitchen sink's, which this row does
 * not port.
 *
 * Runs against the build in app-out/: `just app-build` builds it first.
 */
import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, recordSentToPage, test, trust } from "./fixtures.ts"

const testdata = (name: string) =>
  fs.realpathSync(path.join(import.meta.dirname, "..", "blocks", "aws-auth", "testdata", name))

/** The fake's secret access key: the static key's login (blocks/aws-auth/fake.ts). */
const SECRET = "fake-aws-secret-0001"

/** A secret access key the fake knows no login for. */
const WRONG_SECRET = "fake-aws-wrong-secret-7c3a"

/** Which of `secrets` `text` holds. */
const secretsIn = (text: string, secrets: ReadonlyArray<string>) =>
  secrets.filter((secret) => text.includes(secret))

/**
 * The files under `folder`, by their path in it, that hold any of
 * `secrets`, in UTF-8 or in UTF-16, as Chromium keeps some of its strings.
 * Throws if the folder holds no file, so an empty or wrong folder is not a
 * pass.
 */
const filesHolding = (folder: string, secrets: ReadonlyArray<string>) => {
  const files = fs
    .readdirSync(folder, { recursive: true, encoding: "utf8" })
    .filter((file) => fs.lstatSync(path.join(folder, file)).isFile())
  if (files.length === 0) throw new Error(`${folder} holds no file.`)
  return files.filter((file) => {
    const bytes = fs.readFileSync(path.join(folder, file))
    return secrets.some(
      (secret) => bytes.includes(secret) || bytes.includes(Buffer.from(secret, "utf16le")),
    )
  })
}

/** The fake AWS providers, for this launch only. */
const DEV_MODE = { RUNBOOKS_FAKE_CREDENTIALS: "1" }

/** The block with id `id`. */
const blockOf = (page: Page, id: string) => page.locator(`#runbook-block-${id}`)

/** The card of who the block with id `id` signed in as: each term, then its value. */
const cardOf = (page: Page, id: string) =>
  blockOf(page, id).getByLabel("Signed in as").locator("dt, dd")

test.describe("AwsAuth in the window", () => {
  test("sign-in: a wrong secret key is refused and the right one signs the block in and reaches the run; neither is in a message the window gets, main's output or the user data folder", async ({
    launch,
    userDataDir,
  }) => {
    const { app, page, output } = await launch({ args: [testdata("sign-in")], env: DEV_MODE })
    const sent = await recordSentToPage(app)
    await trust(page)
    const keys = blockOf(page, "keys")

    // kitchen-sink: AwsAuth block renders, and has no errors.
    await expect(keys.getByText("AWS Authentication (Optional)")).toBeVisible()
    await expect(keys.getByLabel("Configuration errors")).toHaveCount(0)
    await expect(keys.getByRole("alert")).toHaveCount(0)

    // long-paths.spec.ts: a long description wraps inside the block, which stays inside the runbook.
    const description = keys.locator(".block-description")
    await expect(description).toContainText("/very/long/path/")
    const fits = await description.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const column = element.closest(".runbook-body")?.getBoundingClientRect()
      return {
        inside: element.scrollWidth <= element.clientWidth,
        within: column !== undefined && box.right <= column.right + 0.5,
      }
    })
    expect(fits).toEqual({ inside: true, within: true })

    // A tab per sign-in method the provider describes, on the block's default.
    await expect(keys.getByRole("tab")).toHaveText([
      "Static Credentials",
      "AWS SSO",
      "Local Profile",
    ])
    await expect(keys.getByRole("tab", { selected: true })).toHaveText("Static Credentials")
    await expect(keys.getByLabel("Default Region")).toHaveValue("eu-west-1")
    await expect(keys.getByLabel(/^Secret Access Key/)).toHaveAttribute("type", "password")

    // The deploy waits for the sign-in.
    const deploy = blockOf(page, "deploy")
    await expect(deploy.getByRole("button", { name: "Run" })).toHaveCount(0)

    // A key the fake knows no login for: the alert says the engine's lastError.
    await keys.getByLabel(/^Access Key ID/).fill("AKIAFAKEEXAMPLE")
    await keys.getByLabel(/^Secret Access Key/).fill(WRONG_SECRET)
    await keys.getByRole("button", { name: "Sign in" }).click()
    await expect(keys.getByRole("alert")).toContainText(
      "Not signed in: The token is not one the fake knows.",
    )
    // The tab and the key id stay as the person left them; the secret goes.
    await expect(keys.getByRole("tab", { selected: true })).toHaveText("Static Credentials")
    await expect(keys.getByLabel(/^Access Key ID/)).toHaveValue("AKIAFAKEEXAMPLE")
    await expect(keys.getByLabel(/^Secret Access Key/)).toHaveValue("")

    await keys.getByLabel(/^Secret Access Key/).fill(SECRET)
    await keys.getByRole("button", { name: "Sign in" }).click()
    await expect(keys.getByText("Signed in.")).toBeVisible()
    await expect(cardOf(page, "keys")).toHaveText([
      "signed in as",
      "arn:aws:iam::111111111111:user/fake-dev",
      "account",
      "fake-production (111111111111)",
      "role",
      "Admin",
    ])

    // The run gets the key through envFrom: its script exits 7 without one.
    await deploy.getByRole("button", { name: "Run" }).click()
    await expect(deploy.locator(".block-status")).toHaveText("Done")

    // Done when: no message main sent the window holds a secret; they hold the sign-in and its error.
    const secrets = [WRONG_SECRET, SECRET]
    const messages = await sent()
    expect(messages.some((message) => message.includes("user/fake-dev"))).toBe(true)
    expect(messages.some((message) => message.includes("not one the fake knows"))).toBe(true)
    expect(messages.filter((message) => secretsIn(message, secrets).length > 0)).toEqual([])
    expect(secretsIn(await page.content(), secrets)).toEqual([])

    // Signing out offers the tabs again.
    await keys.getByRole("button", { name: "Sign out" }).click()
    await expect(keys.getByRole("tab", { selected: true })).toHaveText("Static Credentials")
    await expect(keys.getByLabel(/^Secret Access Key/)).toHaveValue("")

    // Nor is either in what main wrote to its output, or in a file the app left.
    await app.close()
    expect(secretsIn(output(), secrets)).toEqual([])
    expect(filesHolding(userDataDir, secrets)).toEqual([])
  })

  test("sign-in: an AWS SSO sign-in asks for the account, then the role, and the card shows both", async ({
    launch,
  }) => {
    const { page } = await launch({ args: [testdata("sign-in")], env: DEV_MODE })
    await trust(page)
    const sso = blockOf(page, "sso")

    // defaultTab and ssoStartUrl: the tab it opens on, its start URL filled in, the region's default.
    await expect(sso.getByRole("tab", { selected: true })).toHaveText("AWS SSO")
    await expect(sso.getByLabel(/^SSO Start URL/)).toHaveValue("https://fake.awsapps.example/start")
    await expect(sso.getByLabel("SSO Region")).toHaveValue("us-east-1")
    await sso.getByRole("button", { name: "Sign in" }).click()

    const accounts = sso.getByRole("group", { name: "Choose the AWS account" })
    await expect(accounts.getByRole("button")).toHaveText([
      "fake-production (111111111111)",
      "fake-staging (222222222222)",
    ])
    await accounts.getByRole("button", { name: "fake-staging (222222222222)" }).click()

    // The roles are the chosen account's.
    const roles = sso.getByRole("group", { name: "Choose the Role" })
    await expect(roles.getByRole("button")).toHaveText(["Admin"])
    await roles.getByRole("button", { name: "Admin" }).click()

    await expect(sso.getByText("Signed in.")).toBeVisible()
    await expect(cardOf(page, "sso")).toHaveText([
      "signed in as",
      "fake-sso@example.com",
      "account",
      "fake-staging (222222222222)",
      "role",
      "Admin",
      "expires",
      /^\d{4}-\d\d-\d\dT/,
    ])
    // The other block is still signed out.
    await expect(blockOf(page, "keys").getByRole("tab", { selected: true })).toHaveText(
      "Static Credentials",
    )
  })

  test("detect: a login found in the environment waits to be confirmed, unless the block pins what it reaches", async ({
    launch,
  }) => {
    const { page } = await launch({
      args: [testdata("detect")],
      env: { ...DEV_MODE, AWS_SECRET_ACCESS_KEY: SECRET, PROD_AWS_SECRET_ACCESS_KEY: SECRET },
    })
    await trust(page)
    const aws = blockOf(page, "aws")

    await expect(
      aws.getByText("Found a login in the environment Runbooks started in. Use it?"),
    ).toBeVisible()
    await expect(cardOf(page, "aws")).toContainText(["arn:aws:iam::111111111111:user/fake-dev"])
    // Until it is confirmed, no block gets it.
    await expect(blockOf(page, "deploy").getByRole("button", { name: "Run" })).toHaveCount(0)
    // prod pins the account and role the login reaches: it needs no confirmation.
    await expect(blockOf(page, "prod").getByText("Signed in.")).toBeVisible()

    await aws.getByRole("button", { name: "Use this login" }).click()
    await expect(aws.getByText("Signed in.")).toBeVisible()
    await blockOf(page, "deploy").getByRole("button", { name: "Run" }).click()
    await expect(blockOf(page, "deploy").locator(".block-status")).toHaveText("Done")
  })
})
