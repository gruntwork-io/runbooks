/**
 * The fake `aws` provider's script: AWS's methods, fields and levels, as
 * the AWS plugin describes them, answered from memory, for `runbooks test`
 * and the app's dev mode (`blocks/fakes.ts`). It names one value, the
 * secret key, so a run gets AWS_SECRET_ACCESS_KEY and no other key; a
 * detection source finds a login under that name. Its logins:
 *
 * - Static Credentials with the secret key `fake-aws-secret-0001`: an IAM
 *   user in account 111111111111 as role Admin, which it comes with.
 * - AWS SSO, which opens a page and waits: a user who reaches both
 *   accounts, so the person chooses an account, then a role.
 * - Local Profile `fake-dev`: as the static key's user.
 */
import type { FakeScript } from "@runbooks/core/credential/fake"

/** The field every method has: the region a run gets when the credential names none. */
const DEFAULT_REGION = {
  name: "defaultRegion",
  label: "Default Region",
  required: false,
  secret: false,
}

export const AWS_FAKE: FakeScript = {
  prefix: "AWS",
  names: { token: "AWS_SECRET_ACCESS_KEY" },
  methods: [
    {
      name: "credentials",
      label: "Static Credentials",
      tokenField: "secretAccessKey",
      fields: [
        { name: "accessKeyId", label: "Access Key ID", required: true, secret: false },
        { name: "secretAccessKey", label: "Secret Access Key", required: true, secret: true },
        { name: "sessionToken", label: "Session Token", required: false, secret: true },
        DEFAULT_REGION,
      ],
    },
    {
      name: "sso",
      label: "AWS SSO",
      fields: [
        { name: "ssoStartUrl", label: "SSO Start URL", required: true, secret: false },
        { name: "ssoRegion", label: "SSO Region", required: false, secret: false },
        DEFAULT_REGION,
      ],
      prompts: ["openUrl", "waiting"],
      signsInAs: "fake-aws-sso-0001",
    },
    {
      name: "profile",
      label: "Local Profile",
      fields: [
        {
          name: "profile",
          label: "Profile",
          required: true,
          secret: false,
          choices: [{ value: "fake-dev", label: "fake-dev" }],
        },
        DEFAULT_REGION,
      ],
      signsInAs: "fake-aws-secret-0001",
    },
  ],
  levels: [
    { name: "account", label: "AWS account", chosen: "afterSignIn" },
    { name: "role", label: "Role", chosen: "afterSignIn" },
  ],
  targets: {
    account: [
      { id: "111111111111", name: "fake-production" },
      { id: "222222222222", name: "fake-staging" },
    ],
    role: [
      { id: "Admin", name: "Admin", parent: "111111111111" },
      { id: "ReadOnly", name: "ReadOnly", parent: "111111111111" },
      { id: "Admin", name: "Admin", parent: "222222222222" },
    ],
  },
  requirements: [],
  logins: [
    {
      token: "fake-aws-secret-0001",
      principal: "arn:aws:iam::111111111111:user/fake-dev",
      kind: "user",
      targets: { account: "111111111111", role: "Admin" },
    },
    {
      token: "fake-aws-sso-0001",
      principal: "fake-sso@example.com",
      kind: "user",
      lifetimeMillis: 8 * 60 * 60_000,
    },
  ],
}
