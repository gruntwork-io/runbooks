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

func githubValidateRequest(t *testing.T, client ports.GitHubClient, body any) (int, GitHubValidateResponse) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/validate", HandleGitHubValidate(client))

	raw, err := json.Marshal(body)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/validate", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var resp GitHubValidateResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	return w.Code, resp
}

func TestHandleGitHubValidate_MissingTokenRejected(t *testing.T) {
	client := fakes.NewFakeGitHubClient(nil)

	code, resp := githubValidateRequest(t, client, GitHubValidateRequest{})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.False(t, resp.Valid)
	assert.Equal(t, "Token is required", resp.Error)

	// Handler must reject before calling the port.
	assert.Empty(t, client.Calls, "no ValidateToken calls expected when token is empty")
}

func TestHandleGitHubValidate_ValidTokenReturnsUserAndScopes(t *testing.T) {
	client := fakes.NewFakeGitHubClient(&ports.GitHubUser{
		Login:     "octocat",
		Name:      "The Octocat",
		AvatarURL: "https://avatars.example/oc.png",
		Email:     "octo@example.test",
	})
	client.Scopes = []string{"repo", "read:org"}

	code, resp := githubValidateRequest(t, client, GitHubValidateRequest{
		Token: "ghp_abc123def456",
	})

	assert.Equal(t, http.StatusOK, code)
	assert.True(t, resp.Valid)
	require.NotNil(t, resp.User)
	assert.Equal(t, "octocat", resp.User.Login)
	assert.Equal(t, "The Octocat", resp.User.Name)
	assert.Equal(t, []string{"repo", "read:org"}, resp.Scopes)
	assert.Equal(t, GitHubTokenTypeClassicPAT, resp.TokenType, "ghp_ prefix -> classic PAT")

	require.Len(t, client.Calls, 1)
	assert.Equal(t, "ValidateToken", client.Calls[0].Method)
	assert.Equal(t, "ghp_abc123def456", client.Calls[0].Token, "handler must pass the token through unchanged")
}

func TestHandleGitHubValidate_ClientErrorSurfacedAsInvalid(t *testing.T) {
	client := fakes.NewFakeGitHubClient(nil)
	client.QueueValidateErr(errors.New("invalid or expired token"))

	code, resp := githubValidateRequest(t, client, GitHubValidateRequest{
		Token: "ghp_bad",
	})

	// Bad tokens come back as HTTP 200 with Valid:false — keeps the
	// frontend flow single-path (bad creds aren't a transport error).
	assert.Equal(t, http.StatusOK, code)
	assert.False(t, resp.Valid)
	assert.Equal(t, "invalid or expired token", resp.Error)
}

func TestHandleGitHubValidate_TokenTypeDetection(t *testing.T) {
	tests := []struct {
		token    string
		expected GitHubTokenType
	}{
		{"github_pat_xyz", GitHubTokenTypeFineGrainedPAT},
		{"ghp_classic", GitHubTokenTypeClassicPAT},
		{"gho_oauth", GitHubTokenTypeOAuth},
		{"ghs_app", GitHubTokenTypeGitHubApp},
		{"ghu_user", GitHubTokenTypeGitHubApp},
		{"garbage", GitHubTokenTypeUnknown},
	}

	client := fakes.NewFakeGitHubClient(&ports.GitHubUser{Login: "user"})

	for _, tc := range tests {
		t.Run(string(tc.expected), func(t *testing.T) {
			_, resp := githubValidateRequest(t, client, GitHubValidateRequest{Token: tc.token})
			assert.True(t, resp.Valid)
			assert.Equal(t, tc.expected, resp.TokenType)
		})
	}
}
