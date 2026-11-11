/**
 * What AwsAuth will send as the signed-in user for another block: a read, to
 * an AWS API endpoint. The runbook's author chose the request, and is trusted
 * as they are for a Command, so these rules don't name services or
 * operations. They keep the request on AWS's own endpoints and to reads, so a
 * lookup can't change anything by mistake.
 */
import type { HttpRequest } from "../../services/HttpRequest.ts"
import { refuse, shapeRequest, isRefused, type Refused } from "./shape.ts"

/**
 * A regional endpoint, `<service>.<region>.amazonaws.com`, of exactly three
 * labels under amazonaws.com, so a bucket's or an API Gateway's host, which
 * has another label in front, never matches.
 */
const REGIONAL_HOST = /^([a-z0-9-]+)\.([a-z]{2}(?:-gov)?-[a-z]+-\d+)\.amazonaws\.com$/

/** A global endpoint, `<service>.amazonaws.com`, which SigV4 signs for us-east-1. */
const GLOBAL_HOST = /^([a-z0-9-]+)\.amazonaws\.com$/
const GLOBAL_REGION = "us-east-1"

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
}

const ALLOWED_HEADERS = ["accept", "content-type", "x-amz-target"]

/**
 * Whether AwsAuth will send `request`, and if so how to sign it: for the
 * service and region its host names. The request must read, as its shape
 * shows:
 *
 * - An operation in X-Amz-Target (the JSON protocols) or in one Action
 *   parameter (the Query protocol) must start with List, Describe or Get.
 * - A request that names no operation (a REST API) must be a GET.
 */
export function awsSendable(request: HttpRequest): AwsSendable | Refused {
  const shaped = shapeRequest(request, ALLOWED_HEADERS)
  if (isRefused(shaped)) return shaped
  const { url } = shaped

  const signing = signingFor(url.hostname)
  if (!signing) {
    return refuse(
      `AwsAuth sends requests only to AWS API endpoints, such as sso.us-east-2.amazonaws.com or iam.amazonaws.com, not ${url.hostname}.`,
    )
  }

  const action = operation(shaped.request, url)
  if (action !== undefined && typeof action !== "string") return action
  if (action === undefined) {
    if (shaped.request.method !== "GET") {
      return refuse(
        `AwsAuth sends only reads. A request that names no operation in X-Amz-Target or Action must be a GET.`,
      )
    }
  } else if (!READ_PREFIXES.some((prefix) => action.startsWith(prefix))) {
    return refuse(
      `AwsAuth sends only reads, whose operation starts with ${READ_PREFIXES.join(", ")}. ${action} doesn't.`,
    )
  }
  return { request: shaped.request, signing }
}

function signingFor(host: string): AwsSigning | undefined {
  const regional = REGIONAL_HOST.exec(host)
  if (regional?.[1] && regional[2]) return { service: regional[1], region: regional[2] }
  const global = GLOBAL_HOST.exec(host)
  if (global?.[1]) return { service: global[1], region: GLOBAL_REGION }
  return undefined
}

/**
 * The operation the request names, from X-Amz-Target or its Action
 * parameters, or nothing when it names none.
 */
function operation(request: HttpRequest, url: URL): string | Refused | undefined {
  const target = request.headers["x-amz-target"]
  const actions = url.searchParams.getAll("Action")
  const type = request.headers["content-type"] ?? ""
  if (request.body && type.startsWith("application/x-www-form-urlencoded")) {
    actions.push(...new URLSearchParams(request.body).getAll("Action"))
  }
  if (target !== undefined) {
    if (actions.length > 0) {
      return refuse(
        `A request to ${url.hostname} names its operation in X-Amz-Target or in Action, not both.`,
      )
    }
    const action = target.split(".").pop()
    if (!action) {
      return refuse(
        `A request to ${url.hostname} names its operation in the X-Amz-Target header, such as Service.ListThings.`,
      )
    }
    if (url.pathname !== "/" || url.search) {
      return refuse(`An X-Amz-Target request goes to the root path, with no query string.`)
    }
    return action
  }
  if (actions.length === 0) return undefined
  const [action, ...others] = actions
  if (!action || others.length > 0) {
    return refuse(`A request to ${url.hostname} names exactly one Action parameter.`)
  }
  return action
}
