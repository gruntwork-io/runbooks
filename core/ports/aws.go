package ports

import "context"

// AwsCredentials is a plain-value AWS credential triple. The Region is
// included because the handlers and domain code almost always carry it
// alongside the credentials; keeping them together avoids a separate
// parameter on every call site.
type AwsCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Region          string
}

// AwsCallerIdentity is the subset of STS GetCallerIdentity output the
// application cares about, plus a best-effort account alias fetched from
// IAM ListAccountAliases. AccountName is empty when the caller lacks
// iam:ListAccountAliases permission or no alias is set — this is never an
// error.
type AwsCallerIdentity struct {
	AccountID   string
	AccountName string
	Arn         string
}

// AwsRegionOptInStatus is a normalized view of AWS Account API's
// GetRegionOptStatus result. Unknown is returned when the API cannot be
// reached (e.g. missing account:GetRegionOptStatus permission) — callers
// should treat Unknown as "assume enabled" and not surface a warning.
type AwsRegionOptInStatus int

const (
	AwsRegionOptInUnknown AwsRegionOptInStatus = iota
	AwsRegionOptInEnabled
	AwsRegionOptInDisabled
	AwsRegionOptInEnabling
	AwsRegionOptInDisabling
)

// AwsClient is the port for AWS SDK and profile-file operations. Domain
// code never imports aws-sdk-go-v2 directly; it depends on this port so
// hosted deployments can swap in a tenant-scoped client that fetches
// credentials from a vault instead of reading ~/.aws/.
//
// The interface will grow as more handlers migrate off direct SDK use;
// this initial surface covers what HandleAwsValidate needs.
type AwsClient interface {
	// ValidateStaticCredentials calls STS GetCallerIdentity with the given
	// credentials and also best-effort fetches the account alias. The
	// region is the one to issue the STS call in — callers typically pass
	// a known-enabled region (us-east-1) rather than the user's target
	// region, because the target may be opt-in-disabled.
	ValidateStaticCredentials(ctx context.Context, creds AwsCredentials) (*AwsCallerIdentity, error)

	// CheckRegionOptInStatus queries the Account API for whether the given
	// region is enabled for the account. Returns AwsRegionOptInUnknown
	// (and nil error) if the check itself cannot be performed.
	CheckRegionOptInStatus(ctx context.Context, creds AwsCredentials, region string) (AwsRegionOptInStatus, error)
}
