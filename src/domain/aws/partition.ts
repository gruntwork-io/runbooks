/**
 * AWS partition lookups.
 *
 * Each partition has its own set of endpoints, so a call made against the
 * wrong partition fails. STS in the commercial partition rejects GovCloud
 * keys with InvalidClientTokenId, for example.
 */

/**
 * Region that hosts partition-wide endpoints (STS, the Account API) for the
 * partition `region` belongs to.
 *
 * The caller's own region is not used because opt-in regions that the account
 * has not enabled reject every call, including GetCallerIdentity.
 *
 * GovCloud maps to us-gov-west-1 rather than us-gov-east-1 because it is the
 * partition's original region and the only one with an Account API endpoint,
 * as us-east-1 is for the commercial partition. STS would accept either.
 */
export const partitionHomeRegion = (region: string): string => {
  if (region.startsWith("us-gov-")) {
    return "us-gov-west-1"
  }
  return "us-east-1"
}
