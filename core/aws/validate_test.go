package aws_test

import (
	"context"
	"errors"
	"testing"

	coreaws "github.com/gruntwork-io/runbooks/core/aws"
	"github.com/gruntwork-io/runbooks/core/ports"
	"github.com/gruntwork-io/runbooks/core/ports/fakes"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidate_MissingCredentialsRejectedBeforeCallingPort(t *testing.T) {
	client := fakes.NewFakeAwsClient(nil)

	result := coreaws.Validate(context.Background(), client, coreaws.ValidateRequest{
		AccessKeyID: "only-the-id",
	})

	assert.False(t, result.Valid)
	assert.Contains(t, result.Error, "Access Key ID and Secret Access Key are required")
	assert.Empty(t, client.Calls, "no AwsClient calls expected when creds are missing")
}

func TestValidate_ValidCredentialsReturnsIdentity(t *testing.T) {
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{
		AccountID:   "123456789012",
		AccountName: "my-acct",
		Arn:         "arn:aws:iam::123456789012:user/alice",
	})

	result := coreaws.Validate(context.Background(), client, coreaws.ValidateRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "us-east-1",
	})

	assert.True(t, result.Valid)
	assert.Equal(t, "123456789012", result.AccountID)
	assert.Equal(t, "my-acct", result.AccountName)
	assert.Equal(t, "arn:aws:iam::123456789012:user/alice", result.Arn)
	assert.Empty(t, result.Warning, "no warning expected when target region matches validation region")

	require.Len(t, client.Calls, 1)
	assert.Equal(t, "ValidateStaticCredentials", client.Calls[0].Method)
	assert.Equal(t, coreaws.ValidationRegion, client.Calls[0].Creds.Region)
}

func TestValidate_InvalidCredentialsSurfacesError(t *testing.T) {
	client := fakes.NewFakeAwsClient(nil)
	client.QueueValidateErr(errors.New("InvalidClientTokenId: bad"))

	result := coreaws.Validate(context.Background(), client, coreaws.ValidateRequest{
		AccessKeyID:     "bad",
		SecretAccessKey: "bad",
	})

	assert.False(t, result.Valid)
	assert.Contains(t, result.Error, "Invalid credentials")
	assert.Contains(t, result.Error, "InvalidClientTokenId")
}

func TestValidate_DifferentRegionTriggersOptInCheck(t *testing.T) {
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{AccountID: "1"})
	client.OptIn = ports.AwsRegionOptInDisabled

	result := coreaws.Validate(context.Background(), client, coreaws.ValidateRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "af-south-1",
	})

	assert.True(t, result.Valid)
	assert.Contains(t, result.Warning, "af-south-1")
	assert.Contains(t, result.Warning, "not enabled")

	require.Len(t, client.Calls, 2)
	assert.Equal(t, "CheckRegionOptInStatus", client.Calls[1].Method)
	assert.Equal(t, "af-south-1", client.Calls[1].Region)
}

func TestValidate_UnknownOptInStatusOmitsWarning(t *testing.T) {
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{AccountID: "1"})
	client.OptIn = ports.AwsRegionOptInUnknown

	result := coreaws.Validate(context.Background(), client, coreaws.ValidateRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "af-south-1",
	})

	assert.True(t, result.Valid)
	assert.Empty(t, result.Warning)
}

func TestValidate_EnablingRegionShowsTransientWarning(t *testing.T) {
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{AccountID: "1"})
	client.OptIn = ports.AwsRegionOptInEnabling

	result := coreaws.Validate(context.Background(), client, coreaws.ValidateRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "af-south-1",
	})

	assert.True(t, result.Valid)
	assert.Contains(t, result.Warning, "currently being enabled")
}
