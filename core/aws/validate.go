// Package aws contains AWS-related domain logic. All operations
// depend on core/ports interfaces — no direct aws-sdk-go-v2 imports.
// The OS-coupled SDK implementation lives in adapters/SdkAwsClient.
package aws

import (
	"context"
	"fmt"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// ValidationRegion is the region used for STS GetCallerIdentity
// calls during credential validation. us-east-1 is always enabled on
// every AWS account; the user's selected default region may be an
// opt-in region (e.g. af-south-1) that isn't enabled for their
// account, which would make validation fail even with valid
// credentials.
const ValidationRegion = "us-east-1"

// ValidateRequest is the domain-level input for credential
// validation: a credential triple plus the user's target region.
// Region is optional — when empty or equal to ValidationRegion, the
// domain function skips the opt-in check.
type ValidateRequest struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Region          string
}

// ValidateResult is the domain-level outcome: either a validated
// identity (Valid=true) or an error message suitable for surfacing
// to users. Warning is non-empty when the user's target region is
// not currently enabled for the account.
//
// Non-nil Error only appears alongside Valid=false. The shape is
// chosen so HTTP handlers can map it directly to the existing JSON
// response without reshaping.
type ValidateResult struct {
	Valid       bool
	AccountID   string
	AccountName string
	Arn         string
	Warning     string
	Error       string
}

// Validate checks a set of credentials against STS and (when the
// user's target region differs from ValidationRegion) the Account
// API's region opt-in status. Returns a ValidateResult describing
// the outcome; never returns a Go error — all failure modes are
// surfaced as Valid=false + Error so callers don't need branching
// error handling.
//
// Timeout and cancellation are the caller's responsibility: pass a
// context with whatever deadline fits the transport (HTTP handlers
// currently use 10 seconds).
func Validate(ctx context.Context, client ports.AwsClient, req ValidateRequest) ValidateResult {
	if req.AccessKeyID == "" || req.SecretAccessKey == "" {
		return ValidateResult{
			Valid: false,
			Error: "Access Key ID and Secret Access Key are required",
		}
	}

	validationCreds := ports.AwsCredentials{
		AccessKeyID:     req.AccessKeyID,
		SecretAccessKey: req.SecretAccessKey,
		SessionToken:    req.SessionToken,
		Region:          ValidationRegion,
	}
	identity, err := client.ValidateStaticCredentials(ctx, validationCreds)
	if err != nil {
		return ValidateResult{
			Valid: false,
			Error: fmt.Sprintf("Invalid credentials: %v", err),
		}
	}

	var warning string
	if req.Region != "" && req.Region != ValidationRegion {
		status, _ := client.CheckRegionOptInStatus(ctx, validationCreds, req.Region)
		warning = regionOptInWarning(status, req.Region)
	}

	return ValidateResult{
		Valid:       true,
		AccountID:   identity.AccountID,
		AccountName: identity.AccountName,
		Arn:         identity.Arn,
		Warning:     warning,
	}
}

// regionOptInWarning formats a user-visible warning for a region
// that is not currently fully enabled. Returns "" for enabled or
// unknown status. Unknown is treated as "assume enabled" so a
// missing account:GetRegionOptStatus permission doesn't produce a
// spurious warning.
func regionOptInWarning(status ports.AwsRegionOptInStatus, region string) string {
	switch status {
	case ports.AwsRegionOptInDisabled:
		return fmt.Sprintf("The region %s is not enabled for your AWS account. Enable it in the AWS Console under Account Settings > AWS Regions, or choose a different default region.", region)
	case ports.AwsRegionOptInDisabling:
		return fmt.Sprintf("The region %s is currently being disabled for your AWS account.", region)
	case ports.AwsRegionOptInEnabling:
		return fmt.Sprintf("The region %s is currently being enabled for your AWS account. Please wait a few minutes and try again.", region)
	default:
		return ""
	}
}
