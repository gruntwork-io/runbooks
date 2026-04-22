package github_test

import (
	"context"
	"errors"
	"testing"

	coregithub "github.com/gruntwork-io/runbooks/core/github"
	"github.com/gruntwork-io/runbooks/core/ports"
	"github.com/gruntwork-io/runbooks/core/ports/fakes"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDetectTokenType(t *testing.T) {
	tests := []struct {
		token    string
		expected coregithub.TokenType
	}{
		{"github_pat_abc", coregithub.TokenTypeFineGrainedPAT},
		{"ghp_abc", coregithub.TokenTypeClassicPAT},
		{"gho_abc", coregithub.TokenTypeOAuth},
		{"ghs_abc", coregithub.TokenTypeGitHubApp},
		{"ghu_abc", coregithub.TokenTypeGitHubApp},
		{"deadbeef", coregithub.TokenTypeUnknown},
		{"", coregithub.TokenTypeUnknown},
	}
	for _, tt := range tests {
		t.Run(string(tt.expected)+"/"+tt.token, func(t *testing.T) {
			assert.Equal(t, tt.expected, coregithub.DetectTokenType(tt.token))
		})
	}
}

func TestValidate_EmptyTokenRejectedBeforeCallingPort(t *testing.T) {
	client := fakes.NewFakeGitHubClient(nil)

	result := coregithub.Validate(context.Background(), client, "")

	assert.False(t, result.Valid)
	assert.Contains(t, result.Error, "Token is required")
	assert.Empty(t, client.Calls, "no GitHubClient calls expected when token is empty")
}

func TestValidate_ValidTokenReturnsUserAndScopes(t *testing.T) {
	client := fakes.NewFakeGitHubClient(nil)
	client.QueueValidateResponse(
		&ports.GitHubUser{Login: "alice", Name: "Alice A."},
		[]string{"repo", "user"},
	)

	result := coregithub.Validate(context.Background(), client, "ghp_sometoken")

	assert.True(t, result.Valid)
	require.NotNil(t, result.User)
	assert.Equal(t, "alice", result.User.Login)
	assert.Equal(t, []string{"repo", "user"}, result.Scopes)
	assert.Equal(t, coregithub.TokenTypeClassicPAT, result.TokenType)

	require.Len(t, client.Calls, 1)
	assert.Equal(t, "ghp_sometoken", client.Calls[0].Token)
}

func TestValidate_ClientErrorSurfacedAsInvalid(t *testing.T) {
	client := fakes.NewFakeGitHubClient(nil)
	client.QueueValidateErr(errors.New("bad credentials"))

	result := coregithub.Validate(context.Background(), client, "ghp_expired")

	assert.False(t, result.Valid)
	assert.Contains(t, result.Error, "bad credentials")
	// Token type is detected even on failure — callers use it to render
	// a token-type-specific hint in the UI.
	assert.Equal(t, coregithub.TokenTypeClassicPAT, result.TokenType)
}
