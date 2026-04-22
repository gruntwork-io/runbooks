package adapters

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/account"
	"github.com/aws/aws-sdk-go-v2/service/account/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/sts"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// SdkAwsClient is the production AwsClient backed by aws-sdk-go-v2.
// It reads ~/.aws/ and the process environment via the SDK's default
// config loader for operations that accept no explicit credentials.
// Operations that accept ports.AwsCredentials bypass the default chain
// entirely — that keeps domain code's credentials explicit, which is a
// prerequisite for hosted mode.
type SdkAwsClient struct{}

// NewSdkAwsClient constructs the production AWS adapter.
func NewSdkAwsClient() *SdkAwsClient {
	return &SdkAwsClient{}
}

// ValidateStaticCredentials calls STS GetCallerIdentity with the given
// explicit credentials, then best-effort fetches the account alias.
func (c *SdkAwsClient) ValidateStaticCredentials(ctx context.Context, creds ports.AwsCredentials) (*ports.AwsCallerIdentity, error) {
	cfg, err := c.configWithCreds(ctx, creds)
	if err != nil {
		return nil, err
	}

	stsClient := sts.NewFromConfig(cfg)
	result, err := stsClient.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return nil, err
	}

	return &ports.AwsCallerIdentity{
		AccountID:   aws.ToString(result.Account),
		Arn:         aws.ToString(result.Arn),
		AccountName: bestEffortAccountAlias(ctx, cfg),
	}, nil
}

// CheckRegionOptInStatus calls the AWS Account API to determine whether
// a region is opted in. The Account API must be called from us-east-1
// regardless of the region under query. Returns AwsRegionOptInUnknown
// on any error — callers treat that as "assume enabled, don't warn."
func (c *SdkAwsClient) CheckRegionOptInStatus(ctx context.Context, creds ports.AwsCredentials, region string) (ports.AwsRegionOptInStatus, error) {
	// Issue the Account API call from us-east-1, where the Account API
	// lives, regardless of the creds.Region used for other calls.
	queryCreds := creds
	queryCreds.Region = "us-east-1"

	cfg, err := c.configWithCreds(ctx, queryCreds)
	if err != nil {
		return ports.AwsRegionOptInUnknown, err
	}

	client := account.NewFromConfig(cfg)
	result, err := client.GetRegionOptStatus(ctx, &account.GetRegionOptStatusInput{
		RegionName: aws.String(region),
	})
	if err != nil {
		// Missing permission, network trouble, etc. — don't propagate
		// as an error; callers treat Unknown as "don't warn."
		return ports.AwsRegionOptInUnknown, nil
	}

	switch result.RegionOptStatus {
	case types.RegionOptStatusDisabled:
		return ports.AwsRegionOptInDisabled, nil
	case types.RegionOptStatusDisabling:
		return ports.AwsRegionOptInDisabling, nil
	case types.RegionOptStatusEnabling:
		return ports.AwsRegionOptInEnabling, nil
	default:
		return ports.AwsRegionOptInEnabled, nil
	}
}

// configWithCreds builds an aws.Config with explicit static credentials,
// bypassing the default credential chain. Callers that want the default
// chain (profile, env, IMDS) should use the SDK's LoadDefaultConfig
// directly — that path remains allowed because adapters are the OS-
// coupled layer.
func (c *SdkAwsClient) configWithCreds(ctx context.Context, creds ports.AwsCredentials) (aws.Config, error) {
	provider := credentials.NewStaticCredentialsProvider(
		creds.AccessKeyID, creds.SecretAccessKey, creds.SessionToken,
	)
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(creds.Region),
		config.WithCredentialsProvider(provider),
	)
	if err != nil {
		return aws.Config{}, fmt.Errorf("failed to create AWS config: %w", err)
	}
	return cfg, nil
}

// bestEffortAccountAlias fetches the account alias via IAM
// ListAccountAliases. Returns "" on any error — callers must never treat
// a missing alias as an authentication failure.
func bestEffortAccountAlias(ctx context.Context, cfg aws.Config) string {
	// IAM is a global service but the SDK still requires a region; the
	// Account API convention of us-east-1 works here too.
	iamCfg := cfg.Copy()
	iamCfg.Region = "us-east-1"

	client := iam.NewFromConfig(iamCfg)
	result, err := client.ListAccountAliases(ctx, &iam.ListAccountAliasesInput{
		MaxItems: aws.Int32(1),
	})
	if err != nil || len(result.AccountAliases) == 0 {
		return ""
	}
	return result.AccountAliases[0]
}
