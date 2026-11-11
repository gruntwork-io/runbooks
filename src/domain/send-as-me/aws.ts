/**
 * What AwsAuth will send as the signed-in user: reads, to the AWS API
 * endpoints listed here. Each service on the list is one a runbook needs; a
 * service joins when a lookup first needs it. S3 never joins, because its
 * hosts name buckets, and anyone can own a bucket.
 *
 * Hosts are matched exactly, never by pattern. A regional endpoint is
 * `<prefix>.<region>.amazonaws.com`, a host of exactly three labels under
 * amazonaws.com, so a bucket host (`<bucket>.s3.<region>.amazonaws.com`) or
 * an API Gateway host (`<id>.execute-api.<region>.amazonaws.com`) never
 * matches, and neither does an older S3 host such as
 * `s3-us-west-2.amazonaws.com`, whose prefix isn't on the list.
 */
import type { HttpRequest } from "../../services/HttpRequest.ts"
import { refuse, shapeRequest, isRefused, type Refused } from "./shape.ts"

/**
 * How a service names the operation a request performs: in the X-Amz-Target
 * header (the JSON protocols), or in an Action parameter (the Query protocol).
 */
type Protocol = "json" | "query"

interface AwsService {
  /** The name SigV4 signs the request for. */
  readonly signingName: string
  readonly protocol: Protocol
  /**
   * Read operations that return a secret or mint credentials. Refusing them is
   * best effort: no list can name every read that returns a secret.
   */
  readonly secretReads?: readonly string[]
}

/** The services AwsAuth sends to, by the first label of their endpoint's host. */
const SERVICES: Readonly<Record<string, AwsService>> = {
  // IAM Identity Center's admin API: instances, permission sets, assignments.
  sso: { signingName: "sso", protocol: "json" },
  identitystore: { signingName: "identitystore", protocol: "json" },
  organizations: { signingName: "organizations", protocol: "json" },
  sts: {
    signingName: "sts",
    protocol: "query",
    secretReads: ["GetSessionToken", "GetFederationToken"],
  },
  iam: { signingName: "iam", protocol: "query" },
  ec2: {
    signingName: "ec2",
    protocol: "query",
    // The Windows password, and instance user data and console output, which
    // often hold secrets.
    secretReads: [
      "GetPasswordData",
      "GetLaunchTemplateData",
      "DescribeLaunchTemplateVersions",
      "DescribeInstanceAttribute",
      "GetConsoleOutput",
    ],
  },
}

/** Endpoints that name no region, and the region SigV4 signs them for. */
const GLOBAL_HOSTS: Readonly<Record<string, { prefix: string; region: string }>> = {
  "iam.amazonaws.com": { prefix: "iam", region: "us-east-1" },
  "sts.amazonaws.com": { prefix: "sts", region: "us-east-1" },
}

const REGIONAL_HOST = /^([a-z0-9]+)\.([a-z]{2}(?:-gov)?-[a-z]+-\d+)\.amazonaws\.com$/

/** Operations whose names start with these only read. */
const READ_PREFIXES = ["List", "Describe", "Get"]

/** What SigV4 needs to sign a request AwsAuth agreed to send. */
export interface AwsSigning {
  readonly service: string
  readonly region: string
}

export interface AwsSendable {
  readonly request: HttpRequest
  readonly signing: AwsSigning
  /** The operation the request performs, such as ListAccounts. */
  readonly action: string
}

const ALLOWED_HEADERS = ["accept", "content-type", "x-amz-target"]

const listedHosts = (): string =>
  [
    ...Object.keys(SERVICES).map((prefix) => `${prefix}.<region>.amazonaws.com`),
    ...Object.keys(GLOBAL_HOSTS),
  ].join(", ")

/**
 * Whether AwsAuth will send `request`, and if so how to sign it. A request is
 * sent only when its host is a listed endpoint and the operation it names
 * starts with List, Describe or Get and isn't a known secret read.
 */
export function awsSendable(request: HttpRequest): AwsSendable | Refused {
  const shaped = shapeRequest(request, ALLOWED_HEADERS)
  if (isRefused(shaped)) return shaped
  const { url } = shaped

  const target = endpointFor(url.hostname)
  if (!target) {
    return refuse(
      `AwsAuth doesn't send requests to ${url.hostname}. It sends them only to ${listedHosts()}.`,
    )
  }
  const service = SERVICES[target.prefix]
  if (!service) return refuse(`AwsAuth doesn't send requests to ${url.hostname}.`)

  const action =
    service.protocol === "json" ? jsonAction(shaped.request, url) : queryAction(shaped.request, url)
  if (typeof action !== "string") return action

  if (!READ_PREFIXES.some((prefix) => action.startsWith(prefix))) {
    return refuse(
      `AwsAuth sends only reads, whose operation starts with ${READ_PREFIXES.join(", ")}. ${action} doesn't.`,
    )
  }
  if (service.secretReads?.includes(action)) {
    return refuse(`AwsAuth doesn't send ${action}: it returns a secret.`)
  }
  return {
    request: shaped.request,
    signing: { service: service.signingName, region: target.region },
    action,
  }
}

function endpointFor(host: string): { prefix: string; region: string } | undefined {
  const global = GLOBAL_HOSTS[host]
  if (global) return global
  const match = REGIONAL_HOST.exec(host)
  if (!match?.[1] || !match[2] || !(match[1] in SERVICES)) return undefined
  return { prefix: match[1], region: match[2] }
}

/** The operation a JSON-protocol request names in X-Amz-Target, such as `AWSOrganizationsV20161128.ListAccounts`. */
function jsonAction(request: HttpRequest, url: URL): string | Refused {
  if (request.method !== "POST") return refuse(`${url.hostname} takes POST requests.`)
  if (url.pathname !== "/" || url.search) {
    return refuse(`${url.hostname} takes requests to its root path, with no query string.`)
  }
  const target = request.headers["x-amz-target"]
  const action = target?.split(".").pop()
  if (!target || !action) {
    return refuse(
      `A request to ${url.hostname} names its operation in the X-Amz-Target header, such as Service.ListThings.`,
    )
  }
  return action
}

/** The operation a Query-protocol request names in its Action parameter, in the URL or a form body. */
function queryAction(request: HttpRequest, url: URL): string | Refused {
  if (request.headers["x-amz-target"]) {
    return refuse(`${url.hostname} names the operation in an Action parameter, not X-Amz-Target.`)
  }
  const actions = url.searchParams.getAll("Action")
  if (request.method === "POST" && request.body) {
    const type = request.headers["content-type"] ?? ""
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      return refuse(
        `A POST to ${url.hostname} sends its parameters as application/x-www-form-urlencoded.`,
      )
    }
    actions.push(...new URLSearchParams(request.body).getAll("Action"))
  }
  const [action, ...others] = actions
  if (!action || others.length > 0) {
    return refuse(`A request to ${url.hostname} names exactly one Action parameter.`)
  }
  return action
}
