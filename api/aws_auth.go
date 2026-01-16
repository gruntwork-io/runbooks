package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/account"
	"github.com/aws/aws-sdk-go-v2/service/account/types"
	"github.com/aws/aws-sdk-go-v2/service/sso"
	"github.com/aws/aws-sdk-go-v2/service/ssooidc"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/gin-gonic/gin"
	"gopkg.in/ini.v1"
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
	Valid     bool   `json:"valid"`
	AccountID string `json:"accountId,omitempty"`
	Arn       string `json:"arn,omitempty"`
	Error     string `json:"error,omitempty"`
	Warning   string `json:"warning,omitempty"`
}

// ProfileAuthRequest represents the request to authenticate using a profile
type ProfileAuthRequest struct {
	Profile string `json:"profile"`
}

// ProfileAuthResponse represents the response from profile authentication
type ProfileAuthResponse struct {
	Valid           bool   `json:"valid"`
	AccountID       string `json:"accountId,omitempty"`
	Arn             string `json:"arn,omitempty"`
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	SessionToken    string `json:"sessionToken,omitempty"`
	Region          string `json:"region,omitempty"`
	Error           string `json:"error,omitempty"`
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

// SSOPollResponse represents the response from SSO polling
type SSOPollResponse struct {
	Status          string `json:"status"` // "pending", "success", "failed", "select_account"
	AccessKeyID     string `json:"accessKeyId,omitempty"`
	SecretAccessKey string `json:"secretAccessKey,omitempty"`
	SessionToken    string `json:"sessionToken,omitempty"`
	AccountID       string `json:"accountId,omitempty"`
	Arn             string `json:"arn,omitempty"`
	Error           string `json:"error,omitempty"`
	// For account selection flow
	AccessToken string        `json:"accessToken,omitempty"`
	Accounts    []SSOAccount  `json:"accounts,omitempty"`
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
	Arn             string `json:"arn,omitempty"`
	Error           string `json:"error,omitempty"`
}

// ProfileInfo represents an AWS profile with its authentication type
type ProfileInfo struct {
	Name     string `json:"name"`
	AuthType string `json:"authType"` // "sso", "static", "assume_role", "unsupported"
}

// defaultRegion returns the provided region, or "us-east-1" if empty.
func defaultRegion(region string) string {
	if region == "" {
		return "us-east-1"
	}
	return region
}

// callerIdentity holds the result of an STS GetCallerIdentity call.
type callerIdentity struct {
	AccountID string
	Arn       string
}

// getCallerIdentity calls STS GetCallerIdentity using the provided config.
func getCallerIdentity(ctx context.Context, cfg aws.Config) (*callerIdentity, error) {
	stsClient := sts.NewFromConfig(cfg)
	result, err := stsClient.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return nil, err
	}
	return &callerIdentity{
		AccountID: aws.ToString(result.Account),
		Arn:       aws.ToString(result.Arn),
	}, nil
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

// HandleAwsValidate validates AWS credentials by calling STS GetCallerIdentity
func HandleAwsValidate() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req ValidateCredentialsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, ValidateCredentialsResponse{
				Valid: false,
				Error: "Invalid request format",
			})
			return
		}

		if req.AccessKeyID == "" || req.SecretAccessKey == "" {
			c.JSON(http.StatusBadRequest, ValidateCredentialsResponse{
				Valid: false,
				Error: "Access Key ID and Secret Access Key are required",
			})
			return
		}

		// Always use us-east-1 for validation - this is a standard region that's
		// always enabled. The user's selected default region may be an opt-in
		// region (like af-south-1) that isn't enabled for their account, which
		// would cause validation to fail even with valid credentials.
		validationRegion := "us-east-1"

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		cfg, identity, err := validateStaticCredentials(ctx, req.AccessKeyID, req.SecretAccessKey, req.SessionToken, validationRegion)
		if err != nil {
			c.JSON(http.StatusOK, ValidateCredentialsResponse{
				Valid: false,
				Error: fmt.Sprintf("Invalid credentials: %v", err),
			})
			return
		}

		// Check if the user's selected region is enabled (if different from validation region)
		var warning string
		if req.Region != "" && req.Region != validationRegion {
			warning = checkRegionOptInStatus(ctx, cfg, req.Region)
		}

		c.JSON(http.StatusOK, ValidateCredentialsResponse{
			Valid:     true,
			AccountID: identity.AccountID,
			Arn:       identity.Arn,
			Warning:   warning,
		})
	}
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

// HandleAwsProfiles returns a list of AWS profiles from the user's machine
func HandleAwsProfiles() gin.HandlerFunc {
	return func(c *gin.Context) {
		profileInfoMap := make(map[string]*ProfileInfo)

		// Read from ~/.aws/credentials - profiles here have static credentials
		credentialsFile := filepath.Join(os.Getenv("HOME"), ".aws", "credentials")
		if cfg, err := ini.Load(credentialsFile); err == nil {
			for _, section := range cfg.Sections() {
				name := section.Name()
				if name == "DEFAULT" || name == "" {
					continue
				}
				// Check if it has access key credentials
				if section.HasKey("aws_access_key_id") && section.HasKey("aws_secret_access_key") {
					profileInfoMap[name] = &ProfileInfo{
						Name:     name,
						AuthType: "static",
					}
				}
			}
		}

		// Read from ~/.aws/config
		configFile := filepath.Join(os.Getenv("HOME"), ".aws", "config")
		if cfg, err := ini.Load(configFile); err == nil {
			for _, section := range cfg.Sections() {
				name := section.Name()
				if name == "DEFAULT" || name == "" {
					continue
				}

				// Skip non-profile sections (sso-session, services, preview, etc.)
				if strings.HasPrefix(name, "sso-session ") ||
					strings.HasPrefix(name, "services ") ||
					name == "preview" ||
					name == "plugins" {
					continue
				}

				// Config file uses "profile xxx" format for non-default profiles
				name = strings.TrimPrefix(name, "profile ")

				// Determine auth type based on config keys
				authType := determineProfileAuthType(section)

				// If profile already exists from credentials file with static creds, keep that
				if existing, ok := profileInfoMap[name]; ok && existing.AuthType == "static" {
					continue
				}

				profileInfoMap[name] = &ProfileInfo{
					Name:     name,
					AuthType: authType,
				}
			}
		}

		// Convert to sorted slice
		profiles := make([]ProfileInfo, 0, len(profileInfoMap))
		for _, info := range profileInfoMap {
			profiles = append(profiles, *info)
		}
		sort.Slice(profiles, func(i, j int) bool {
			return profiles[i].Name < profiles[j].Name
		})

		c.JSON(http.StatusOK, gin.H{"profiles": profiles})
	}
}

// determineProfileAuthType checks the section keys to determine the auth type
func determineProfileAuthType(section *ini.Section) string {
	// Check for SSO configuration
	if section.HasKey("sso_start_url") || section.HasKey("sso_session") {
		return "sso"
	}

	// Check for assume role configuration
	if section.HasKey("role_arn") {
		// Assume role requires a source - could be source_profile or credential_source
		if section.HasKey("source_profile") || section.HasKey("credential_source") {
			return "assume_role"
		}
		// role_arn without source might be web identity or other
		if section.HasKey("web_identity_token_file") {
			return "unsupported" // Web identity not supported
		}
		return "unsupported"
	}

	// Check for static credentials in config file
	if section.HasKey("aws_access_key_id") && section.HasKey("aws_secret_access_key") {
		return "static"
	}

	// Check for credential process (not supported)
	if section.HasKey("credential_process") {
		return "unsupported"
	}

	// Unknown/default - might be inheriting from default or environment
	return "unsupported"
}

// HandleAwsProfileAuth authenticates using a local AWS profile
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

		if req.Profile == "" {
			c.JSON(http.StatusBadRequest, ProfileAuthResponse{
				Valid: false,
				Error: "Profile name is required",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Load AWS config with the specified profile
		cfg, err := config.LoadDefaultConfig(ctx,
			config.WithSharedConfigProfile(req.Profile),
		)
		if err != nil {
			c.JSON(http.StatusOK, ProfileAuthResponse{
				Valid: false,
				Error: fmt.Sprintf("Failed to load profile '%s': %v", req.Profile, err),
			})
			return
		}

		// Get credentials from the profile
		creds, err := cfg.Credentials.Retrieve(ctx)
		if err != nil {
			c.JSON(http.StatusOK, ProfileAuthResponse{
				Valid: false,
				Error: fmt.Sprintf("Failed to retrieve credentials from profile: %v", err),
			})
			return
		}

		// Validate by calling STS GetCallerIdentity
		identity, err := getCallerIdentity(ctx, cfg)
		if err != nil {
			c.JSON(http.StatusOK, ProfileAuthResponse{
				Valid: false,
				Error: fmt.Sprintf("Invalid credentials in profile: %v", err),
			})
			return
		}

		c.JSON(http.StatusOK, ProfileAuthResponse{
			Valid:           true,
			AccountID:       identity.AccountID,
			Arn:             identity.Arn,
			AccessKeyID:     creds.AccessKeyID,
			SecretAccessKey: creds.SecretAccessKey,
			SessionToken:    creds.SessionToken,
			Region:          cfg.Region,
		})
	}
}

// HandleAwsSsoStart initiates AWS SSO device authorization
func HandleAwsSsoStart() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOStartRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOStartResponse{
				Error: "Invalid request format",
			})
			return
		}

		if req.StartURL == "" {
			c.JSON(http.StatusBadRequest, SSOStartResponse{
				Error: "SSO Start URL is required",
			})
			return
		}

		region := defaultRegion(req.Region)

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		// Create SSO OIDC client
		cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
		if err != nil {
			c.JSON(http.StatusOK, SSOStartResponse{
				Error: fmt.Sprintf("Failed to create AWS config: %v", err),
			})
			return
		}

		oidcClient := ssooidc.NewFromConfig(cfg)

		// Register client
		clientName := "runbooks-aws-auth"
		registerResult, err := oidcClient.RegisterClient(ctx, &ssooidc.RegisterClientInput{
			ClientName: aws.String(clientName),
			ClientType: aws.String("public"),
		})
		if err != nil {
			c.JSON(http.StatusOK, SSOStartResponse{
				Error: fmt.Sprintf("Failed to register SSO client: %v", err),
			})
			return
		}

		// Start device authorization
		authResult, err := oidcClient.StartDeviceAuthorization(ctx, &ssooidc.StartDeviceAuthorizationInput{
			ClientId:     registerResult.ClientId,
			ClientSecret: registerResult.ClientSecret,
			StartUrl:     aws.String(req.StartURL),
		})
		if err != nil {
			c.JSON(http.StatusOK, SSOStartResponse{
				Error: fmt.Sprintf("Failed to start device authorization: %v", err),
			})
			return
		}

		// Build the verification URI with the user code
		verificationUri := aws.ToString(authResult.VerificationUriComplete)
		if verificationUri == "" {
			verificationUri = aws.ToString(authResult.VerificationUri)
		}

		c.JSON(http.StatusOK, SSOStartResponse{
			VerificationUri: verificationUri,
			UserCode:        aws.ToString(authResult.UserCode),
			DeviceCode:      aws.ToString(authResult.DeviceCode),
			ClientID:        aws.ToString(registerResult.ClientId),
			ClientSecret:    aws.ToString(registerResult.ClientSecret),
		})
	}
}

// HandleAwsSsoPoll polls for SSO authentication completion
func HandleAwsSsoPoll() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOPollRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOPollResponse{
				Status: "failed",
				Error:  "Invalid request format",
			})
			return
		}

		region := defaultRegion(req.Region)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
		if err != nil {
			c.JSON(http.StatusOK, SSOPollResponse{
				Status: "failed",
				Error:  fmt.Sprintf("Failed to create AWS config: %v", err),
			})
			return
		}

		oidcClient := ssooidc.NewFromConfig(cfg)

	// Try to create token
	tokenResult, err := oidcClient.CreateToken(ctx, &ssooidc.CreateTokenInput{
		ClientId:     aws.String(req.ClientID),
		ClientSecret: aws.String(req.ClientSecret),
		DeviceCode:   aws.String(req.DeviceCode),
		GrantType:    aws.String("urn:ietf:params:oauth:grant-type:device_code"),
	})
	if err != nil {
		errStr := err.Error()
		// Check if authorization is still pending
		if strings.Contains(errStr, "AuthorizationPendingException") ||
			strings.Contains(errStr, "authorization_pending") {
			c.JSON(http.StatusOK, SSOPollResponse{
				Status: "pending",
			})
			return
		}
		// Check for slow down request
		if strings.Contains(errStr, "SlowDownException") ||
			strings.Contains(errStr, "slow_down") {
			c.JSON(http.StatusOK, SSOPollResponse{
				Status: "pending",
			})
			return
		}
		// Check if user denied/cancelled the authorization
		if strings.Contains(errStr, "AccessDeniedException") ||
			strings.Contains(errStr, "access_denied") {
			c.JSON(http.StatusOK, SSOPollResponse{
				Status: "failed",
				Error:  "Authorization was denied or cancelled",
			})
			return
		}
		// Check if the device code expired
		if strings.Contains(errStr, "ExpiredTokenException") ||
			strings.Contains(errStr, "expired_token") {
			c.JSON(http.StatusOK, SSOPollResponse{
				Status: "failed",
				Error:  "Authorization request expired. Please try again.",
			})
			return
		}
		c.JSON(http.StatusOK, SSOPollResponse{
			Status: "failed",
			Error:  fmt.Sprintf("SSO authentication failed: %v", err),
		})
		return
	}

		// Got the access token, now we need to get role credentials
		accessToken := aws.ToString(tokenResult.AccessToken)

		// If no account/role specified, list accounts and let user choose
		if req.AccountID == "" || req.RoleName == "" {
			// List accounts to give the user info
			ssoClient := sso.NewFromConfig(cfg)
			accountsResult, err := ssoClient.ListAccounts(ctx, &sso.ListAccountsInput{
				AccessToken: aws.String(accessToken),
			})
			if err != nil {
				c.JSON(http.StatusOK, SSOPollResponse{
					Status: "failed",
					Error:  fmt.Sprintf("Failed to list SSO accounts: %v", err),
				})
				return
			}

			if len(accountsResult.AccountList) == 0 {
				c.JSON(http.StatusOK, SSOPollResponse{
					Status: "failed",
					Error:  "No accounts available in SSO",
				})
				return
			}

			// If there's only one account, check if it has only one role
			if len(accountsResult.AccountList) == 1 {
				account := accountsResult.AccountList[0]
				rolesResult, err := ssoClient.ListAccountRoles(ctx, &sso.ListAccountRolesInput{
					AccessToken: aws.String(accessToken),
					AccountId:   account.AccountId,
				})
				if err != nil || len(rolesResult.RoleList) == 0 {
					c.JSON(http.StatusOK, SSOPollResponse{
						Status: "failed",
						Error:  "No roles available for the account",
					})
					return
				}

				// If only one account with one role, auto-select
				if len(rolesResult.RoleList) == 1 {
					req.AccountID = aws.ToString(account.AccountId)
					req.RoleName = aws.ToString(rolesResult.RoleList[0].RoleName)
				} else {
					// One account, multiple roles - need selection
					accounts := make([]SSOAccount, len(accountsResult.AccountList))
					for i, acc := range accountsResult.AccountList {
						accounts[i] = SSOAccount{
							AccountID:    aws.ToString(acc.AccountId),
							AccountName:  aws.ToString(acc.AccountName),
							EmailAddress: aws.ToString(acc.EmailAddress),
						}
					}
					c.JSON(http.StatusOK, SSOPollResponse{
						Status:      "select_account",
						AccessToken: accessToken,
						Accounts:    accounts,
					})
					return
				}
			} else {
				// Multiple accounts - return list for user selection
				accounts := make([]SSOAccount, len(accountsResult.AccountList))
				for i, acc := range accountsResult.AccountList {
					accounts[i] = SSOAccount{
						AccountID:    aws.ToString(acc.AccountId),
						AccountName:  aws.ToString(acc.AccountName),
						EmailAddress: aws.ToString(acc.EmailAddress),
					}
				}
				c.JSON(http.StatusOK, SSOPollResponse{
					Status:      "select_account",
					AccessToken: accessToken,
					Accounts:    accounts,
				})
				return
			}
		}

		// Get role credentials
		ssoClient := sso.NewFromConfig(cfg)
		credsResult, err := ssoClient.GetRoleCredentials(ctx, &sso.GetRoleCredentialsInput{
			AccessToken: aws.String(accessToken),
			AccountId:   aws.String(req.AccountID),
			RoleName:    aws.String(req.RoleName),
		})
		if err != nil {
			c.JSON(http.StatusOK, SSOPollResponse{
				Status: "failed",
				Error:  fmt.Sprintf("Failed to get role credentials: %v", err),
			})
			return
		}

		// Validate the credentials
		accessKeyID := aws.ToString(credsResult.RoleCredentials.AccessKeyId)
		secretAccessKey := aws.ToString(credsResult.RoleCredentials.SecretAccessKey)
		sessionToken := aws.ToString(credsResult.RoleCredentials.SessionToken)

		_, identity, err := validateStaticCredentials(ctx, accessKeyID, secretAccessKey, sessionToken, region)
		if err != nil {
			c.JSON(http.StatusOK, SSOPollResponse{
				Status: "failed",
				Error:  fmt.Sprintf("Failed to validate SSO credentials: %v", err),
			})
			return
		}

		c.JSON(http.StatusOK, SSOPollResponse{
			Status:          "success",
			AccessKeyID:     accessKeyID,
			SecretAccessKey: secretAccessKey,
			SessionToken:    sessionToken,
			AccountID:       identity.AccountID,
			Arn:             identity.Arn,
		})
	}
}

// HandleAwsSsoListRoles lists available roles for an SSO account
func HandleAwsSsoListRoles() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOListRolesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOListRolesResponse{
				Error: "Invalid request format",
			})
			return
		}

		if req.AccessToken == "" || req.AccountID == "" {
			c.JSON(http.StatusBadRequest, SSOListRolesResponse{
				Error: "Access token and account ID are required",
			})
			return
		}

		region := defaultRegion(req.Region)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
		if err != nil {
			c.JSON(http.StatusOK, SSOListRolesResponse{
				Error: fmt.Sprintf("Failed to create AWS config: %v", err),
			})
			return
		}

		ssoClient := sso.NewFromConfig(cfg)
		rolesResult, err := ssoClient.ListAccountRoles(ctx, &sso.ListAccountRolesInput{
			AccessToken: aws.String(req.AccessToken),
			AccountId:   aws.String(req.AccountID),
		})
		if err != nil {
			c.JSON(http.StatusOK, SSOListRolesResponse{
				Error: fmt.Sprintf("Failed to list roles: %v", err),
			})
			return
		}

		roles := make([]SSORole, len(rolesResult.RoleList))
		for i, role := range rolesResult.RoleList {
			roles[i] = SSORole{
				RoleName: aws.ToString(role.RoleName),
			}
		}

		c.JSON(http.StatusOK, SSOListRolesResponse{
			Roles: roles,
		})
	}
}

// HandleAwsSsoComplete completes SSO authentication with selected account/role
func HandleAwsSsoComplete() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req SSOCompleteRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, SSOCompleteResponse{
				Error: "Invalid request format",
			})
			return
		}

		if req.AccessToken == "" || req.AccountID == "" || req.RoleName == "" {
			c.JSON(http.StatusBadRequest, SSOCompleteResponse{
				Error: "Access token, account ID, and role name are required",
			})
			return
		}

		region := defaultRegion(req.Region)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
		if err != nil {
			c.JSON(http.StatusOK, SSOCompleteResponse{
				Error: fmt.Sprintf("Failed to create AWS config: %v", err),
			})
			return
		}

		// Get role credentials
		ssoClient := sso.NewFromConfig(cfg)
		credsResult, err := ssoClient.GetRoleCredentials(ctx, &sso.GetRoleCredentialsInput{
			AccessToken: aws.String(req.AccessToken),
			AccountId:   aws.String(req.AccountID),
			RoleName:    aws.String(req.RoleName),
		})
		if err != nil {
			c.JSON(http.StatusOK, SSOCompleteResponse{
				Error: fmt.Sprintf("Failed to get role credentials: %v", err),
			})
			return
		}

		// Validate the credentials
		accessKeyID := aws.ToString(credsResult.RoleCredentials.AccessKeyId)
		secretAccessKey := aws.ToString(credsResult.RoleCredentials.SecretAccessKey)
		sessionToken := aws.ToString(credsResult.RoleCredentials.SessionToken)

		_, identity, err := validateStaticCredentials(ctx, accessKeyID, secretAccessKey, sessionToken, region)
		if err != nil {
			c.JSON(http.StatusOK, SSOCompleteResponse{
				Error: fmt.Sprintf("Failed to validate SSO credentials: %v", err),
			})
			return
		}

		c.JSON(http.StatusOK, SSOCompleteResponse{
			AccessKeyID:     accessKeyID,
			SecretAccessKey: secretAccessKey,
			SessionToken:    sessionToken,
			AccountID:       identity.AccountID,
			Arn:             identity.Arn,
		})
	}
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

// HandleAwsCheckRegion checks if a region is enabled for the account
func HandleAwsCheckRegion() gin.HandlerFunc {
	return func(c *gin.Context) {
		var req CheckRegionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, CheckRegionResponse{
				Error: "Invalid request format",
			})
			return
		}

		if req.Region == "" {
			c.JSON(http.StatusBadRequest, CheckRegionResponse{
				Error: "Region is required",
			})
			return
		}

		if req.AccessKeyID == "" || req.SecretAccessKey == "" {
			c.JSON(http.StatusBadRequest, CheckRegionResponse{
				Error: "Credentials are required",
			})
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// Create credentials provider
		creds := credentials.NewStaticCredentialsProvider(
			req.AccessKeyID,
			req.SecretAccessKey,
			req.SessionToken,
		)

		// Account API must be called from us-east-1
		cfg, err := config.LoadDefaultConfig(ctx,
			config.WithRegion("us-east-1"),
			config.WithCredentialsProvider(creds),
		)
		if err != nil {
			c.JSON(http.StatusOK, CheckRegionResponse{
				Enabled: true, // Assume enabled if we can't check
				Error:   fmt.Sprintf("Failed to create AWS config: %v", err),
			})
			return
		}

		accountClient := account.NewFromConfig(cfg)
		result, err := accountClient.GetRegionOptStatus(ctx, &account.GetRegionOptStatusInput{
			RegionName: aws.String(req.Region),
		})
		if err != nil {
			// If we can't check (e.g., insufficient permissions), assume enabled
			c.JSON(http.StatusOK, CheckRegionResponse{
				Enabled: true,
			})
			return
		}

		switch result.RegionOptStatus {
		case types.RegionOptStatusDisabled:
			c.JSON(http.StatusOK, CheckRegionResponse{
				Enabled: false,
				Status:  "disabled",
				Warning: fmt.Sprintf("The region %s is not enabled for your AWS account. Enable it in the AWS Console under Account Settings > AWS Regions, or choose a different default region.", req.Region),
			})
		case types.RegionOptStatusDisabling:
			c.JSON(http.StatusOK, CheckRegionResponse{
				Enabled: false,
				Status:  "disabling",
				Warning: fmt.Sprintf("The region %s is currently being disabled for your AWS account.", req.Region),
			})
		case types.RegionOptStatusEnabling:
			c.JSON(http.StatusOK, CheckRegionResponse{
				Enabled: false,
				Status:  "enabling",
				Warning: fmt.Sprintf("The region %s is currently being enabled for your AWS account. Please wait a few minutes and try again.", req.Region),
			})
		default:
			// ENABLED or ENABLED_BY_DEFAULT
			c.JSON(http.StatusOK, CheckRegionResponse{
				Enabled: true,
				Status:  "enabled",
			})
		}
	}
}


