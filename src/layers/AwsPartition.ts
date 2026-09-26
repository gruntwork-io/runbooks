/**
 * AWS partition lookups, answered from the SDK's own partition data.
 *
 * Each partition (commercial, China, GovCloud, the ISO partitions, the
 * European Sovereign Cloud, ...) has its own endpoints, so a call made against
 * the wrong partition fails: STS in the commercial partition rejects GovCloud
 * keys with InvalidClientTokenId, for example. Reading the partitions from
 * @aws-sdk/util-endpoints means a partition AWS adds arrives with an SDK
 * upgrade instead of an edit here.
 */
import { partition } from "@aws-sdk/util-endpoints"

/**
 * Region that hosts partition-wide endpoints (STS, IAM, the Account API) for
 * the partition `region` belongs to: the partition's implicit global region,
 * such as us-east-1 for commercial regions and us-gov-west-1 for GovCloud.
 *
 * The caller's own region is not used because opt-in regions that the account
 * has not enabled reject every call, including GetCallerIdentity. A region no
 * partition claims resolves to the commercial partition, as the SDK's own
 * endpoint resolution does. `implicitGlobalRegion` is in the SDK's partition
 * data but not yet in its published type, so should an SDK ever omit it the
 * region itself is used: an endpoint in the right partition.
 */
export const partitionHomeRegion = (region: string): string => {
  const { implicitGlobalRegion } = partition(region) as { implicitGlobalRegion?: string }
  return implicitGlobalRegion || region
}
