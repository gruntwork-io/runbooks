package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/account"
	"github.com/aws/aws-sdk-go-v2/service/account/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	sso_types "github.com/aws/aws-sdk-go-v2/service/sso/types"
	ssooidc_types "github.com/aws/aws-sdk-go-v2/service/ssooidc/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/gin-gonic/gin"
	"gopkg.in/ini.v1"

	"github.com/gruntwork-io/runbooks/core/ports"
)

// Pre-compiled regexes for AWS environment variable validation.
// These are used on every credential detection and confirmation request,
// so we compile them once at package level to avoid repeated overhead.
var (
	allowedAwsEnvVarPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*_(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_REGION)$`)
	validAwsEnvVarPrefixPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*_$`)
)

// =============================================================================
// Types
// =============================================================================

// AuthType represents the type of authentication for an AWS profile
type AuthType string

const (
	AuthTypeSSO         AuthType = "sso"
	AuthTypeStatic      AuthType = "static"
	AuthTypeAssumeRole  AuthType = "assume_role"
	AuthTypeUnsupported AuthType = "unsupported"
)

// ValidateCredentialsRequest represents the request to validate AWS credentials
type ValidateCredentialsRequest struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	SessionToken    string `json:"sessionToken,omitempty"`
	Region          string `json:"region"`
}

// ValidateCredentialsResponse represents the response from credential validation
type ValidateCredentialsResponse struct {
	Valid       bool   `json:"valid"`
	AccountID   string `json:"accountId,omitempty"`
	AccountName string `json:"accountName,omitempty"` // Account alias, if available
	Arn         string `json:"arn,omitempty"`
	Error       string `json:"error,omitempty"`
	Warning     string `json:"warning,omitempty"`
}

// ProfileAuthRequest represents the request to authenticate using a profile
type ProfileAuthRequest struct {
	Profile string `json:"profile"`
}

// ProfileAuthResponse represents the response from profile authentication
type ProfileAuthResponse struct {
	Valid           bool   `json:"valid"`
	AccountID       string `json:"accountId,omitempty"`
	AccountName     string `json:"accountName,omitempty"` // Account alias, if available
	Arn             string `json:"arn,omitempty"`
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	SessionToken    string `json:"sessionToken,omitempty"`
	Region          string `json:"region,omitempty"`
	Error           string `json:"error,omitempty"`
}

// ProfileInfo represents an AWS profile with its authentication type
type ProfileInfo struct {
	Name     string   `json:"name"`
	AuthType AuthType `json:"authType"`
}

// SSOStartRequest represents the request to start SSO authentication
type SSOStartRequest struct {
	StartURL  string `json:"startUrl"`
	Region    string `json:"region"`
	AccountID string `json:"accountId,omitempty"`
	RoleName  string `json:"roleName,omitempty"`
}

// SSOStartResponse represents the response from starting SSO
type SSOStartResponse struct {
	VerificationUri string `json:"verificationUri,omitempty"`
	UserCode        string `json:"userCode,omitempty"`
	DeviceCode      string `json:"deviceCode,omitempty"`
	ClientID        string `json:"clientId,omitempty"`
	ClientSecret    string `json:"clientSecret,omitempty"`
	Error           string `json:"error,omitempty"`
}

// SSOPollRequest represents the request to poll for SSO completion
type SSOPollRequest struct {
	DeviceCode   string `json:"deviceCode"`
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	Region       string `json:"region"`
	AccountID    string `json:"accountId,omitempty"`
	RoleName     string `json:"roleName,omitempty"`
}

// SSOPollStatus represents the status of an SSO poll response
type SSOPollStatus string

const (
	SSOPollStatusPending       SSOPollStatus = "pending"
	SSOPollStatusSuccess       SSOPollStatus = "success"
	SSOPollStatusFailed        SSOPollStatus = "failed"
	SSOPollStatusSelectAccount SSOPollStatus = "select_account"
)

// SSOPollResponse represents the response from SSO polling
type SSOPollResponse struct {
	Status          SSOPollStatus `json:"status"`
	AccessKeyID     string        `json:"accessKeyId,omitempty"`
	SecretAccessKey string        `json:"secretAccessKey,omitempty"`
	SessionToken    string        `json:"sessionToken,omitempty"`
	AccountID       string        `json:"accountId,omitempty"`
	AccountName     string        `json:"accountName,omitempty"` // Account alias, if available
	Arn             string        `json:"arn,omitempty"`
	Error           string        `json:"error,omitempty"`
	// For account selection flow
	AccessToken string       `json:"accessToken,omitempty"`
	Accounts    []SSOAccount `json:"accounts,omitempty"`
}

// SSOAccount represents an AWS account from SSO
type SSOAccount struct {
	AccountID    string `json:"accountId"`
	AccountName  string `json:"accountName"`
	EmailAddress string `json:"emailAddress"`
}

// SSORole represents a role available in an SSO account
type SSORole struct {
	RoleName string `json:"roleName"`
}

// SSOListRolesRequest represents a request to list roles for an account
type SSOListRolesRequest struct {
	AccessToken string `json:"accessToken"`
	AccountID   string `json:"accountId"`
	Region      string `json:"region"`
}

// SSOListRolesResponse represents the response with available roles
type SSOListRolesResponse struct {
	Roles []SSORole `json:"roles,omitempty"`
	Error string    `json:"error,omitempty"`
}

// SSOCompleteRequest represents a request to complete SSO with selected account/role
type SSOCompleteRequest struct {
	AccessToken string `json:"accessToken"`
	AccountID   string `json:"accountId"`
	RoleName    string `json:"roleName"`
	Region      string `json:"region"`
}

// SSOCompleteResponse represents the response after completing SSO
type SSOCompleteResponse struct {
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	SessionToken    string `json:"sessionToken,omitempty"`
	AccountID       string `json:"accountId,omitempty"`
	AccountName     string `json:"accountName,omitempty"` // Account alias, if available
	Arn             string `json:"arn,omitempty"`
	Error           string `json:"error,omitempty"`
}

// CheckRegionRequest represents a request to check if a region is enabled
type CheckRegionRequest struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	SessionToken    string `json:"sessionToken,omitempty"`
	Region          string `json:"region"`
}

// CheckRegionResponse represents the response from region check
type CheckRegionResponse struct {
	Enabled bool   `json:"enabled"`
	Status  string `json:"status,omitempty"`
	Warning string `json:"warning,omitempty"`
	Error   string `json:"error,omitempty"`
}

// EnvCredentialsRequest represents a request to read and validate AWS credentials from environment variables
type EnvCredentialsRequest struct {
	Prefix        string `json:"prefix"`
	AwsAuthID     string `json:"awsAuthId"`
	DefaultRegion string `json:"defaultRegion"`
}

// EnvCredentialsResponse represents the response from environment credential validation
// Note: Raw credentials are NEVER returned to the frontend for security
type EnvCredentialsResponse struct {
	Found           bool   `json:"found"`
	Valid           bool   `json:"valid,omitempty"`
	AccountID       string `json:"accountId,omitempty"`
	AccountName     string `json:"accountName,omitempty"` // Account alias, if available
	Arn             string `json:"arn,omitempty"`
	Region          string `json:"region,omitempty"`
	HasSessionToken bool   `json:"hasSessionToken,omitempty"`
	Warning         string `json:"warning,omitempty"`
	Error           string `json:"error,omitempty"`
}

// callerIdentity holds the result of an STS GetCallerIdentity call.
type callerIdentity struct {
	AccountID   string
	AccountName string // Account alias, if available (best-effort)
	Arn         string
}

// ssoTokenStatus represents the status of an SSO token creation attempt.
type ssoTokenStatus string

const (
	ssoTokenPending ssoTokenStatus = "pending"
	ssoTokenFailed  ssoTokenStatus = "failed"
)

// =============================================================================
// Handlers
// =============================================================================

// HandleAwsValidate validates AWS credentials. The HTTP handler is a
// thin adapter: it parses JSON and delegates to
// ValidateAwsCredentials. All credential-handling logic lives in
// core/aws via the pure Ops function.
func HandleAwsValidate(aws ports.AwsClient) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ValidateCredentialsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, ValidateCredentialsResponse{
				Valid: false,
				Error: "Invalid request format",
			})
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
		defer cancel()

		c.JSON(http.StatusOK, ValidateAwsCredentials(ctx, aws, req))
	}
}

// HandleAwsProfiles returns the list of AWS profiles discovered in
// the local shared-config files. Delegates to ListAwsProfiles.
func HandleAwsProfiles() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"profiles": ListAwsProfiles()})
	}
}

// HandleAwsProfileAuth authenticates using a local AWS profile.
// Delegates to AuthenticateAwsProfile.
func HandleAwsProfileAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ProfileAuthRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, ProfileAuthResponse{
				Valid: false,
				Error: "Invalid request format",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		c.JSON(http.StatusOK, AuthenticateAwsProfile(ctx, req.Profile))
	}
}

// HandleAwsSsoStart initiates AWS SSO device authorization. Delegates
// to StartAwsSSO.
func HandleAwsSsoStart() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOStartRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOStartResponse{
				Error: "Invalid request format",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		c.JSON(http.StatusOK, StartAwsSSO(ctx, req))
	}
}

// HandleAwsSsoPoll polls for SSO authentication completion. Delegates
// to PollAwsSSO.
func HandleAwsSsoPoll() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOPollRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOPollResponse{
				Status: SSOPollStatusFailed,
				Error:  "Invalid request format",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		c.JSON(http.StatusOK, PollAwsSSO(ctx, req))
	}
}

// HandleAwsSsoListRoles lists available roles for an SSO account.
// Delegates to ListAwsSSORoles.
func HandleAwsSsoListRoles() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOListRolesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOListRolesResponse{
				Error: "Invalid request format",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		c.JSON(http.StatusOK, ListAwsSSORoles(ctx, req))
	}
}

// HandleAwsSsoComplete completes SSO authentication with selected
// account/role. Delegates to CompleteAwsSSO.
func HandleAwsSsoComplete() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOCompleteRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOCompleteResponse{
				Error: "Invalid request format",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		c.JSON(http.StatusOK, CompleteAwsSSO(ctx, req))
	}
}

// HandleAwsCheckRegion checks if a region is enabled for the account.
// Delegates to CheckAwsRegion.
func HandleAwsCheckRegion() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req CheckRegionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, CheckRegionResponse{
				Error: "Invalid request format",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		c.JSON(http.StatusOK, CheckAwsRegion(ctx, req))
	}
}

// HandleAwsEnvCredentials reads AWS credentials from the process
// environment and validates them, but does NOT register them to the
// session. Delegates to DetectAwsEnvCredentials.
func HandleAwsEnvCredentials() gin.HandlerFunc {
	return func(c *gin.Context) {
		prefix := c.Query("prefix")
		defaultRegion := c.Query("defaultRegion")
		c.JSON(http.StatusOK, DetectAwsEnvCredentials(prefix, defaultRegion))
	}
}

// ConfirmEnvCredentialsRequest represents a request to confirm and register
// detected environment credentials to the session.
type ConfirmEnvCredentialsRequest struct {
	Prefix        string `json:"prefix"`
	DefaultRegion string `json:"defaultRegion"`
}

// ConfirmEnvCredentialsResponse represents the response from confirming environment credentials.
// Unlike the detection endpoint, this DOES return credentials so the frontend can store them
// per-block for the awsAuthId feature. This is a calculated security trade-off:
// - Credentials are already in the user's shell environment
// - Request is localhost-only
// - Request requires a session token
type ConfirmEnvCredentialsResponse struct {
	Found           bool   `json:"found"`
	Valid           bool   `json:"valid,omitempty"`
	AccountID       string `json:"accountId,omitempty"`
	AccountName     string `json:"accountName,omitempty"`
	Arn             string `json:"arn,omitempty"`
	Region          string `json:"region,omitempty"`
	HasSessionToken bool   `json:"hasSessionToken,omitempty"`
	Warning         string `json:"warning,omitempty"`
	Error           string `json:"error,omitempty"`
	// Credentials are returned so frontend can store them per-block for awsAuthId support
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	SessionToken    string `json:"sessionToken,omitempty"`
}

// HandleAwsConfirmEnvCredentials reads AWS credentials from the
// process environment and registers them to the session. Delegates
// to ConfirmAwsEnvCredentials.
func HandleAwsConfirmEnvCredentials(sm *SessionManager) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ConfirmEnvCredentialsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, ConfirmEnvCredentialsResponse{
				Found: false,
				Error: "Invalid request format",
			})
			return
		}

		c.JSON(http.StatusOK, ConfirmAwsEnvCredentials(sm, req))
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

// validatedEnvCredentials holds the result of reading and validating AWS
// environment credentials. Used by both the detection and confirmation handlers.
type validatedEnvCredentials struct {
	Found           bool
	Valid           bool
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Region          string
	Identity        *callerIdentity
	Warning         string
	Error           string
}

// readAndValidateAwsEnvCredentials reads AWS credentials from environment variables,
// validates them via STS, and checks region opt-in status. This is the shared logic
// between HandleAwsEnvCredentials (detection) and HandleAwsConfirmEnvCredentials
// (confirmation).
func readAndValidateAwsEnvCredentials(prefix, defaultRegion string) *validatedEnvCredentials {
	creds, found, err := ReadAwsEnvCredentials(prefix)
	if err != nil {
		return &validatedEnvCredentials{
			Found: false,
			Error: err.Error(),
		}
	}

	if !found {
		return &validatedEnvCredentials{
			Found: false,
			Error: fmt.Sprintf("%sAWS_ACCESS_KEY_ID or %sAWS_SECRET_ACCESS_KEY not found in environment", prefix, prefix),
		}
	}

	region := resolveRegion(creds.Region, defaultRegion)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cfg, identity, err := validateStaticCredentials(ctx, creds.AccessKeyID, creds.SecretAccessKey, creds.SessionToken, "us-east-1")
	if err != nil {
		return &validatedEnvCredentials{
			Found: true,
			Valid: false,
			Error: fmt.Sprintf("Credentials found but invalid: %v", err),
		}
	}

	var warning string
	if region != "us-east-1" {
		warning = checkRegionOptInStatus(ctx, cfg, region)
	}

	return &validatedEnvCredentials{
		Found:           true,
		Valid:           true,
		AccessKeyID:     creds.AccessKeyID,
		SecretAccessKey: creds.SecretAccessKey,
		SessionToken:    creds.SessionToken,
		Region:          region,
		Identity:        identity,
		Warning:         warning,
	}
}

// formatSSOError provides user-friendly error messages for common SSO errors.
func formatSSOError(err error, region, startURL string) string {
	errStr := err.Error()

	// Check for InvalidRequestException - usually wrong region
	if strings.Contains(errStr, "InvalidRequestException") {
		return fmt.Sprintf("SSO region mismatch: The SSO Start URL '%s' does not exist in region '%s'. "+
			"Check your IAM Identity Center settings in the AWS Console to find the correct region, "+
			"then update the 'ssoRegion' prop in your AwsAuth block.",
			startURL, region)
	}

	// Check for invalid start URL format
	if strings.Contains(errStr, "InvalidClientException") {
		return fmt.Sprintf("Invalid SSO configuration: The SSO client could not be registered. "+
			"Verify that '%s' is a valid AWS IAM Identity Center start URL.",
			startURL)
	}

	// Check for access denied
	if strings.Contains(errStr, "AccessDeniedException") || strings.Contains(errStr, "UnauthorizedException") {
		return "Access denied: You don't have permission to access this IAM Identity Center instance. " +
			"Contact your AWS administrator."
	}

	// Check for network/connection errors
	if strings.Contains(errStr, "connection refused") || strings.Contains(errStr, "no such host") {
		return fmt.Sprintf("Connection failed: Could not reach the SSO endpoint for region '%s'. "+
			"Check your network connection and verify the region is correct.",
			region)
	}

	// Default: include original error but add context
	return fmt.Sprintf("SSO authentication failed: %v. "+
		"If you're seeing an InvalidRequestException, the most common cause is an incorrect 'ssoRegion' setting.",
		err)
}

// resolveRegion returns the first provided non-empty region, or "us-east-1".
func resolveRegion(region string, fallbackRegions ...string) string {
	if region != "" {
		return region
	}
	for _, f := range fallbackRegions {
		if f != "" {
			return f
		}
	}
	return "us-east-1"
}

// getCallerIdentity calls STS GetCallerIdentity using the provided config.
// It also attempts to fetch the account alias (best-effort, won't fail if unavailable).
func getCallerIdentity(ctx context.Context, cfg aws.Config) (*callerIdentity, error) {
	stsClient := sts.NewFromConfig(cfg)
	result, err := stsClient.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return nil, err
	}

	identity := &callerIdentity{
		AccountID: aws.ToString(result.Account),
		Arn:       aws.ToString(result.Arn),
	}

	// Best-effort: try to get account alias (won't fail if permission denied)
	identity.AccountName = getAccountAlias(ctx, cfg)

	return identity, nil
}

// getAccountAlias attempts to fetch the AWS account alias using IAM ListAccountAliases.
// Returns empty string if the alias cannot be fetched (no permission, no alias set, etc.).
// This is best-effort and should never cause authentication to fail.
func getAccountAlias(ctx context.Context, cfg aws.Config) string {
	// IAM is a global service, but we need to use us-east-1 for the API call
	iamCfg := cfg.Copy()
	iamCfg.Region = "us-east-1"

	iamClient := iam.NewFromConfig(iamCfg)
	result, err := iamClient.ListAccountAliases(ctx, &iam.ListAccountAliasesInput{
		MaxItems: aws.Int32(1), // We only need the first (and typically only) alias
	})
	if err != nil {
		// Silently ignore errors - user may not have iam:ListAccountAliases permission
		return ""
	}

	if len(result.AccountAliases) > 0 {
		return result.AccountAliases[0]
	}

	return ""
}

// validateStaticCredentials creates an AWS config with static credentials and validates them via STS.
// Returns the config (for further use) and the caller identity.
func validateStaticCredentials(ctx context.Context, accessKeyID, secretAccessKey, sessionToken, region string) (aws.Config, *callerIdentity, error) {
	creds := credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, sessionToken)
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		config.WithCredentialsProvider(creds),
	)
	if err != nil {
		return aws.Config{}, nil, fmt.Errorf("failed to create AWS config: %w", err)
	}

	identity, err := getCallerIdentity(ctx, cfg)
	if err != nil {
		return aws.Config{}, nil, err
	}

	return cfg, identity, nil
}

// classifySSOTokenError examines an SSO token creation error and returns
// the appropriate status and error message.
func classifySSOTokenError(err error) (ssoTokenStatus, string) {
	var authPending *ssooidc_types.AuthorizationPendingException
	var slowDown *ssooidc_types.SlowDownException
	var accessDenied *ssooidc_types.AccessDeniedException
	var expiredToken *ssooidc_types.ExpiredTokenException

	// Authorization still pending - user hasn't completed browser flow yet
	if errors.As(err, &authPending) {
		return ssoTokenPending, ""
	}

	// Slow down request - treat as pending
	if errors.As(err, &slowDown) {
		return ssoTokenPending, ""
	}

	// User denied/cancelled the authorization
	if errors.As(err, &accessDenied) {
		return ssoTokenFailed, "Authorization was denied or cancelled"
	}

	// Device code expired
	if errors.As(err, &expiredToken) {
		return ssoTokenFailed, "Authorization request expired. Please try again."
	}

	// Unknown error
	return ssoTokenFailed, fmt.Sprintf("SSO authentication failed: %v", err)
}

// convertToSSOAccounts converts AWS SDK account info to our SSOAccount type.
func convertToSSOAccounts(accounts []sso_types.AccountInfo) []SSOAccount {
	result := make([]SSOAccount, len(accounts))
	for i, acc := range accounts {
		result[i] = SSOAccount{
			AccountID:    aws.ToString(acc.AccountId),
			AccountName:  aws.ToString(acc.AccountName),
			EmailAddress: aws.ToString(acc.EmailAddress),
		}
	}
	return result
}

// checkRegionOptInStatus checks if a region requires opt-in and whether it's enabled.
// Returns a warning message if the region is not enabled, empty string otherwise.
func checkRegionOptInStatus(ctx context.Context, cfg aws.Config, region string) string {
	// The Account API must be called from us-east-1
	accountCfg := cfg.Copy()
	accountCfg.Region = "us-east-1"

	accountClient := account.NewFromConfig(accountCfg)
	result, err := accountClient.GetRegionOptStatus(ctx, &account.GetRegionOptStatusInput{
		RegionName: aws.String(region),
	})
	if err != nil {
		// If we can't check (e.g., insufficient permissions), don't warn
		// The user will see the actual error when they try to use the region
		return ""
	}

	switch result.RegionOptStatus {
	case types.RegionOptStatusDisabled:
		return fmt.Sprintf("The region %s is not enabled for your AWS account. Enable it in the AWS Console under Account Settings > AWS Regions, or choose a different default region.", region)
	case types.RegionOptStatusDisabling:
		return fmt.Sprintf("The region %s is currently being disabled for your AWS account.", region)
	case types.RegionOptStatusEnabling:
		return fmt.Sprintf("The region %s is currently being enabled for your AWS account. Please wait a few minutes and try again.", region)
	default:
		// ENABLED or ENABLED_BY_DEFAULT - no warning needed
		return ""
	}
}

// determineProfileAuthType checks the section keys to determine the auth type
func determineProfileAuthType(section *ini.Section) AuthType {
	// Check for SSO configuration
	if section.HasKey("sso_start_url") || section.HasKey("sso_session") {
		return AuthTypeSSO
	}

	// Check for assume role configuration
	if section.HasKey("role_arn") {
		// Assume role requires a source - could be source_profile or credential_source
		if section.HasKey("source_profile") || section.HasKey("credential_source") {
			return AuthTypeAssumeRole
		}
		// role_arn without source might be web identity or other
		if section.HasKey("web_identity_token_file") {
			return AuthTypeUnsupported // Web identity not supported
		}
		return AuthTypeUnsupported
	}

	// Check for static credentials in config file
	if section.HasKey("aws_access_key_id") && section.HasKey("aws_secret_access_key") {
		return AuthTypeStatic
	}

	// Check for credential process (not supported)
	if section.HasKey("credential_process") {
		return AuthTypeUnsupported
	}

	// Unknown/default - might be inheriting from default or environment
	return AuthTypeUnsupported
}

// =============================================================================
// Environment Variable Validation (Security)
// =============================================================================

// isAllowedAwsEnvVar validates that an environment variable name is a permitted
// AWS credential variable for the detection path. This prevents arbitrary
// env var probing when no specific envVar is requested.
// Allowed patterns:
//   - Exactly "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", or "AWS_REGION"
//   - Prefixed variants like "PREFIX_AWS_ACCESS_KEY_ID" or "PROD_AWS_SECRET_ACCESS_KEY"
//
// The prefix must be uppercase letters, digits, or underscores, and the full name
// must end with one of the standard AWS credential variable names.
func isAllowedAwsEnvVar(name string) bool {
	if name == "" {
		return false
	}

	// Exact matches for standard names
	standardVars := []string{
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
	}
	for _, v := range standardVars {
		if name == v {
			return true
		}
	}

	// Check for prefixed variants - must end with _AWS_... and prefix must be valid
	return allowedAwsEnvVarPattern.MatchString(name)
}

// isValidAwsEnvVarPrefix validates that a prefix is safe to use when constructing
// environment variable names. Must be empty or contain only uppercase letters,
// digits, and underscores, and must end with an underscore. The trailing underscore
// is required because the prefix is concatenated directly with "AWS_ACCESS_KEY_ID"
// etc., and without it the resulting name (e.g. "MYAWS_ACCESS_KEY_ID") would not
// match the allowed env var pattern which requires an underscore separator.
func isValidAwsEnvVarPrefix(prefix string) bool {
	if prefix == "" {
		return true
	}
	// Prefix must be uppercase alphanumeric with underscores, ending with underscore
	return validAwsEnvVarPrefixPattern.MatchString(prefix)
}

// AwsEnvCredentials holds AWS credentials read from environment variables.
type AwsEnvCredentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Region          string
}

// ReadAwsEnvCredentials reads AWS credentials from environment variables with an optional prefix.
// Returns the credentials and whether required credentials (access key + secret) were found.
// Does NOT validate credentials against AWS - just reads from environment.
// Returns an error if the prefix is invalid.
//
// An optional getenv function can be provided to override how environment variables are read.
// If nil or not provided, os.Getenv is used. This is useful for testing, where environment
// variable overrides need to be respected without mutating the real process environment.
// NOTE: We use variadic function parameters to make passing a getenv function optional
// (versus requiring that a function always be passed).
func ReadAwsEnvCredentials(prefix string, getenvFn ...func(string) string) (creds AwsEnvCredentials, found bool, err error) {
	getenv := os.Getenv
	if len(getenvFn) > 0 && getenvFn[0] != nil {
		getenv = getenvFn[0]
	}

	// Validate the prefix before using it (security: prevent arbitrary env var probing)
	if !isValidAwsEnvVarPrefix(prefix) {
		return creds, false, fmt.Errorf("invalid prefix: must be uppercase alphanumeric with underscores, ending with an underscore (e.g. \"PROD_\")")
	}

	// Construct env var names
	accessKeyIDName := prefix + "AWS_ACCESS_KEY_ID"
	secretAccessKeyName := prefix + "AWS_SECRET_ACCESS_KEY"
	sessionTokenName := prefix + "AWS_SESSION_TOKEN"
	regionName := prefix + "AWS_REGION"

	// Validate constructed names (defense in depth)
	if !isAllowedAwsEnvVar(accessKeyIDName) || !isAllowedAwsEnvVar(secretAccessKeyName) {
		return creds, false, fmt.Errorf("invalid prefix results in disallowed environment variable name")
	}

	// Read credentials from environment using the provided (or default) lookup function
	creds.AccessKeyID = getenv(accessKeyIDName)
	creds.SecretAccessKey = getenv(secretAccessKeyName)
	creds.SessionToken = getenv(sessionTokenName)
	creds.Region = getenv(regionName)

	found = creds.AccessKeyID != "" && creds.SecretAccessKey != ""
	return creds, found, nil
}