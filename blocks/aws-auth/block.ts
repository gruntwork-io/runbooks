/**
 * AwsAuth: signs in to AWS, and gives the blocks that name it in `envFrom`
 * (or `awsAuthId`) the credential's environment. A credential block: it
 * does no I/O, and turns its props into one request for the `aws`
 * provider, whose answers the engine moves the block through. The common
 * auth view draws it.
 *
 * - Its sign-in methods are the provider's: Static Credentials, AWS SSO
 *   and Local Profile. `defaultTab` names the one it opens on; any other
 *   value, or none, opens Static Credentials, as today's block does.
 * - `detectCredentials` lists where to look for a login first: the
 *   environment (`"env"`), the environment under a prefix, and an earlier
 *   block's outputs (`{ block }`, at most one). `false` turns detection
 *   off. By default it looks in the environment.
 * - `ssoAccountId` with `ssoRoleName` pins the account and role: a login
 *   that cannot reach them is refused, and one that can needs no
 *   confirmation. `ssoAccountId` alone pins nothing, as today.
 * - `ssoStartUrl` and `ssoRegion` fill in the SSO tab's fields, and
 *   `defaultRegion` every tab's Default Region, and is the region a run
 *   gets when the credential names none.
 * - Its outputs are the region and the credential's expiry: identity, not
 *   keys. The keys reach a run only through `envFrom`.
 */
import { Option, Schema } from "effect"
import {
  BlockId,
  type CredentialRequest,
  defineCredential,
  type DetectSource,
  type InstructionStep,
} from "@runbooks/blocks-core/contract"

/** Every name the provider may set for a run, the keys among them. */
const AWS_NAMES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_CREDENTIAL_EXPIRATION",
] as const

/** The provider's sign-in methods, the block's tabs, in its order. */
const METHODS = ["credentials", "sso", "profile"] as const

/** What today's block uses when the author names no region. */
const US_EAST_1 = "us-east-1"

/**
 * Where to look for a login. A prefix is any string, as today's block
 * passes it on: `PROD_` reads PROD_AWS_ACCESS_KEY_ID.
 */
const Source = Schema.Union([
  Schema.Literal("env"),
  Schema.Struct({ env: Schema.Struct({ prefix: Schema.optionalKey(Schema.String) }) }),
  Schema.Struct({ block: BlockId }),
])

const AwsAuthProps = Schema.Struct({
  ssoStartUrl: Schema.optionalKey(Schema.String),
  ssoRegion: Schema.optionalKey(Schema.String),
  ssoAccountId: Schema.optionalKey(Schema.String),
  ssoRoleName: Schema.optionalKey(Schema.String),
  defaultRegion: Schema.optionalKey(Schema.String),
  defaultTab: Schema.optionalKey(Schema.String),
  detectCredentials: Schema.optionalKey(
    Schema.Union([Schema.Literal(false), Schema.Array(Source)]),
  ),
}).check(
  Schema.makeFilter((p) =>
    Array.isArray(p.detectCredentials) &&
    p.detectCredentials.filter((source) => typeof source === "object" && "block" in source).length >
      1
      ? {
          path: ["detectCredentials"],
          issue: "it names more than one block: an AwsAuth block reads one block's outputs at most",
        }
      : undefined,
  ),
)
export type AwsAuthProps = typeof AwsAuthProps.Type

const sourceOf = (source: typeof Source.Type): DetectSource => {
  if (source === "env") return { kind: "env", prefix: Option.none() }
  if ("block" in source) return { kind: "outputs", from: source.block }
  return { kind: "env", prefix: Option.fromUndefinedOr(source.env.prefix) }
}

export const request = (p: AwsAuthProps): CredentialRequest => {
  const region = { defaultRegion: p.defaultRegion ?? US_EAST_1 }
  const tab = METHODS.find((method) => method === p.defaultTab) ?? "credentials"
  return {
    detect:
      p.detectCredentials === false ? [] : (p.detectCredentials ?? ["env" as const]).map(sourceOf),
    pins:
      p.ssoAccountId !== undefined && p.ssoRoleName !== undefined
        ? { account: p.ssoAccountId, role: p.ssoRoleName }
        : {},
    requirements: [],
    settings: p.defaultRegion === undefined ? {} : { defaultRegion: p.defaultRegion },
    defaultMethod: Option.some(tab),
    methodDefaults: {
      credentials: region,
      sso: {
        ...(p.ssoStartUrl === undefined ? {} : { ssoStartUrl: p.ssoStartUrl }),
        ssoRegion: p.ssoRegion ?? US_EAST_1,
        ...region,
      },
      profile: region,
    },
  }
}

/** `text` as inline code, in a fence longer than any run of backticks in it. */
const code = (text: string): string => {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length))
  const fence = "`".repeat(longest + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

/** Instruction mode's "Log into AWS", with the SSO details to sign in by hand. */
export const instruction = (p: AwsAuthProps): ReadonlyArray<InstructionStep> => {
  const hints = [
    ["SSO start URL", p.ssoStartUrl],
    ["SSO region", p.ssoRegion],
    ["Role", p.ssoRoleName],
  ].flatMap(([label, value]) => (value ? [`- ${label}: ${code(value)}`] : []))
  return [
    {
      kind: "text",
      markdown: p.ssoAccountId
        ? `Log into AWS in the ${code(p.ssoAccountId)} account.`
        : "Log into AWS.",
    },
    ...(hints.length === 0 ? [] : [{ kind: "text" as const, markdown: hints.join("\n") }]),
  ]
}

export const awsAuth = defineCredential({
  name: "AwsAuth",
  since: "0.1.0",
  class: "credential",
  props: AwsAuthProps,
  children: { kind: "none" },
  references: {},
  runbookFiles: () => [],
  provides: ["env"],
  effects: ["network", "browser"],
  scope: "aws",
  provider: "aws",
  envNames: AWS_NAMES,
  outputs: () => ({
    AWS_REGION: { sensitive: false },
    AWS_CREDENTIAL_EXPIRATION: { sensitive: false },
  }),
  request,
  instruction,
})
