package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gruntwork-io/runbooks/core/ports"
	"github.com/gruntwork-io/runbooks/core/ports/fakes"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// validateRequest fires HandleAwsValidate with the given body and client.
// Returns the HTTP status and parsed response.
func validateRequest(t *testing.T, client ports.AwsClient, body any) (int, ValidateCredentialsResponse) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/validate", HandleAwsValidate(client))

	raw, err := json.Marshal(body)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/validate", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var resp ValidateCredentialsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	return w.Code, resp
}

func TestHandleAwsValidate_MissingCredentialsRejected(t *testing.T) {
	client := fakes.NewFakeAwsClient(nil)

	_, resp := validateRequest(t, client, ValidateCredentialsRequest{
		AccessKeyID: "only-the-id",
	})
	assert.False(t, resp.Valid)
	assert.Contains(t, resp.Error, "Access Key ID and Secret Access Key are required")

	// The handler must reject before calling the port.
	assert.Empty(t, client.Calls, "no AwsClient calls expected when creds are missing")
}

func TestHandleAwsValidate_ValidCredentialsReturnsIdentity(t *testing.T) {
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{
		AccountID:   "123456789012",
		AccountName: "my-acct",
		Arn:         "arn:aws:iam::123456789012:user/alice",
	})

	code, resp := validateRequest(t, client, ValidateCredentialsRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "us-east-1",
	})

	assert.Equal(t, http.StatusOK, code)
	assert.True(t, resp.Valid)
	assert.Equal(t, "123456789012", resp.AccountID)
	assert.Equal(t, "my-acct", resp.AccountName)
	assert.Equal(t, "arn:aws:iam::123456789012:user/alice", resp.Arn)
	assert.Empty(t, resp.Warning, "no warning expected when target region matches validation region")

	// One ValidateStaticCredentials call; no opt-in check (region == validation region).
	require.Len(t, client.Calls, 1)
	assert.Equal(t, "ValidateStaticCredentials", client.Calls[0].Method)
	assert.Equal(t, "us-east-1", client.Calls[0].Creds.Region, "handler must validate against us-east-1")
}

func TestHandleAwsValidate_InvalidCredentialsReturns400ShapedError(t *testing.T) {
	client := fakes.NewFakeAwsClient(nil)
	client.QueueValidateErr(errors.New("InvalidClientTokenId: The security token included in the request is invalid."))

	code, resp := validateRequest(t, client, ValidateCredentialsRequest{
		AccessKeyID:     "bad",
		SecretAccessKey: "bad",
		Region:          "us-east-1",
	})

	// The handler returns 200 with Valid:false to keep the frontend flow
	// single-path — bad creds aren't an HTTP-level error.
	assert.Equal(t, http.StatusOK, code)
	assert.False(t, resp.Valid)
	assert.Contains(t, resp.Error, "Invalid credentials")
	assert.Contains(t, resp.Error, "InvalidClientTokenId")
}

func TestHandleAwsValidate_DifferentRegionTriggersOptInCheck(t *testing.T) {
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{AccountID: "1"})
	client.OptIn = ports.AwsRegionOptInDisabled

	_, resp := validateRequest(t, client, ValidateCredentialsRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "af-south-1",
	})

	assert.True(t, resp.Valid)
	assert.Contains(t, resp.Warning, "af-south-1")
	assert.Contains(t, resp.Warning, "not enabled")

	require.Len(t, client.Calls, 2)
	assert.Equal(t, "ValidateStaticCredentials", client.Calls[0].Method)
	assert.Equal(t, "CheckRegionOptInStatus", client.Calls[1].Method)
	assert.Equal(t, "af-south-1", client.Calls[1].Region)
}

func TestHandleAwsValidate_UnknownOptInStatusOmitsWarning(t *testing.T) {
	// When the Account API can't be reached (e.g. missing permission), the
	// adapter returns AwsRegionOptInUnknown with nil error. The handler
	// must not surface a warning in that case — the user will see a real
	// error if the region truly isn't enabled.
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{AccountID: "1"})
	client.OptIn = ports.AwsRegionOptInUnknown

	_, resp := validateRequest(t, client, ValidateCredentialsRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "af-south-1",
	})

	assert.True(t, resp.Valid)
	assert.Empty(t, resp.Warning)
}

func TestHandleAwsValidate_EnablingRegionShowsTransientWarning(t *testing.T) {
	client := fakes.NewFakeAwsClient(&ports.AwsCallerIdentity{AccountID: "1"})
	client.OptIn = ports.AwsRegionOptInEnabling

	_, resp := validateRequest(t, client, ValidateCredentialsRequest{
		AccessKeyID:     "AKIA...",
		SecretAccessKey: "secret",
		Region:          "af-south-1",
	})

	assert.True(t, resp.Valid)
	assert.Contains(t, resp.Warning, "currently being enabled")
}
