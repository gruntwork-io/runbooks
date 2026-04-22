// Package github contains GitHub-related domain logic. All
// operations depend on core/ports interfaces — no direct GitHub
// REST client imports. The HTTP adapter lives in
// adapters/HttpGitHubClient.
package github

import (
	"context"
	"strings"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// TokenType identifies what kind of GitHub credential a token
// represents. Detected purely from the token's prefix — no network
// calls — so it's cheap to include in every validation response.
type TokenType string

const (
	TokenTypeClassicPAT     TokenType = "classic_pat"
	TokenTypeFineGrainedPAT TokenType = "fine_grained_pat"
	TokenTypeOAuth          TokenType = "oauth"
	TokenTypeGitHubApp      TokenType = "github_app"
	TokenTypeUnknown        TokenType = "unknown"
)

// DetectTokenType classifies a GitHub token by its documented
// prefix. Returns TokenTypeUnknown for tokens with no recognized
// prefix (legacy 40-char hex tokens, invalid strings, etc).
func DetectTokenType(token string) TokenType {
	switch {
	case strings.HasPrefix(token, "github_pat_"):
		return TokenTypeFineGrainedPAT
	case strings.HasPrefix(token, "ghp_"):
		return TokenTypeClassicPAT
	case strings.HasPrefix(token, "gho_"):
		return TokenTypeOAuth
	case strings.HasPrefix(token, "ghs_"), strings.HasPrefix(token, "ghu_"):
		return TokenTypeGitHubApp
	default:
		return TokenTypeUnknown
	}
}

// ValidateResult is the domain-level outcome of token validation.
// Invalid is encoded via Valid=false + Error rather than a Go error
// so HTTP handlers can map directly to JSON without branching.
type ValidateResult struct {
	Valid     bool
	User      *ports.GitHubUser
	Scopes    []string
	TokenType TokenType
	Error     string
}

// Validate calls the GitHub user endpoint through the provided
// client and returns a domain-level result. TokenType is always
// populated (even on failure) since it's derived locally from the
// token string. Empty tokens return Valid=false with a descriptive
// error; the port is not called.
//
// The caller owns the context and therefore the timeout.
func Validate(ctx context.Context, client ports.GitHubClient, token string) ValidateResult {
	if token == "" {
		return ValidateResult{
			Valid: false,
			Error: "Token is required",
		}
	}

	user, scopes, err := client.ValidateToken(ctx, token)
	if err != nil {
		return ValidateResult{
			Valid:     false,
			TokenType: DetectTokenType(token),
			Error:     err.Error(),
		}
	}

	return ValidateResult{
		Valid:     true,
		User:      user,
		Scopes:    scopes,
		TokenType: DetectTokenType(token),
	}
}
