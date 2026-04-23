package api

import (
	"context"
	"fmt"
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
	"gopkg.in/ini.v1"

	coreaws "github.com/gruntwork-io/runbooks/core/aws"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// This file collects the transport-free AWS operations shared by the
// HTTP handlers in aws_auth.go and the IPC methods on
// services.AwsService. Each function takes validated inputs (plus
// shared domain dependencies like ports.AwsClient / SessionManager)
// and returns the response struct the handler would write back. Errors
// surface through the response's Error field — never as Go errors —
// so callers don't need branching error handling.

// ValidateAwsCredentials runs the credential-validation pipeline
// (STS GetCallerIdentity + optional region opt-in check). Delegates
// to core/aws.Validate so the SDK is reached only through the
// AwsClient port.
func ValidateAwsCredentials(ctx context.Context, client ports.AwsClient, req ValidateCredentialsRequest) ValidateCredentialsResponse {
	result := coreaws.Validate(ctx, client, coreaws.ValidateRequest{
		AccessKeyID:     req.AccessKeyID,
		SecretAccessKey: req.SecretAccessKey,
		SessionToken:    req.SessionToken,
		Region:          req.Region,
	})
	return ValidateCredentialsResponse{
		Valid:       result.Valid,
		AccountID:   result.AccountID,
		AccountName: result.AccountName,
		Arn:         result.Arn,
		Warning:     result.Warning,
		Error:       result.Error,
	}
}

// ListAwsProfiles enumerates AWS profiles from ~/.aws/credentials and
// ~/.aws/config. Returns an empty slice if home directory can't be
// resolved — that matches the legacy handler's "best effort" contract.
func ListAwsProfiles() []ProfileInfo {
	profileInfoMap := make(map[string]*ProfileInfo)

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return []ProfileInfo{}
	}

	credentialsFile := filepath.Join(homeDir, ".aws", "credentials")
	if cfg, err := ini.Load(credentialsFile); err == nil {
		for _, section := range cfg.Sections() {
			name := section.Name()
			if name == "DEFAULT" || name == "" {
				continue
			}
			if section.HasKey("aws_access_key_id") && section.HasKey("aws_secret_access_key") {
				profileInfoMap[name] = &ProfileInfo{
					Name:     name,
					AuthType: AuthTypeStatic,
				}
			}
		}
	}

	configFile := filepath.Join(homeDir, ".aws", "config")
	if cfg, err := ini.Load(configFile); err == nil {
		for _, section := range cfg.Sections() {
			name := section.Name()
			if name == "DEFAULT" || name == "" {
				continue
			}
			if strings.HasPrefix(name, "sso-session ") ||
				strings.HasPrefix(name, "services ") ||
				name == "preview" ||
				name == "plugins" {
				continue
			}
			name = strings.TrimPrefix(name, "profile ")
			authType := determineProfileAuthType(section)
			if existing, ok := profileInfoMap[name]; ok && existing.AuthType == AuthTypeStatic {
				continue
			}
			profileInfoMap[name] = &ProfileInfo{
				Name:     name,
				AuthType: authType,
			}
		}
	}

	profiles := make([]ProfileInfo, 0, len(profileInfoMap))
	for _, info := range profileInfoMap {
		profiles = append(profiles, *info)
	}
	sort.Slice(profiles, func(i, j int) bool {
		return profiles[i].Name < profiles[j].Name
	})
	return profiles
}

// AuthenticateAwsProfile loads a shared-config profile, resolves its
// credentials, and validates them via STS. Returns a populated
// response with Valid=false and a user-facing Error on any failure.
func AuthenticateAwsProfile(ctx context.Context, profile string) ProfileAuthResponse {
	if profile == "" {
		return ProfileAuthResponse{
			Valid: false,
			Error: "Profile name is required",
		}
	}

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithSharedConfigProfile(profile),
	)
	if err != nil {
		return ProfileAuthResponse{
			Valid: false,
			Error: fmt.Sprintf("Failed to load profile '%s': %v", profile, err),
		}
	}

	creds, err := cfg.Credentials.Retrieve(ctx)
	if err != nil {
		return ProfileAuthResponse{
			Valid: false,
			Error: fmt.Sprintf("Failed to retrieve credentials from profile: %v", err),
		}
	}

	identity, err := getCallerIdentity(ctx, cfg)
	if err != nil {
		return ProfileAuthResponse{
			Valid: false,
			Error: fmt.Sprintf("Invalid credentials in profile: %v", err),
		}
	}

	return ProfileAuthResponse{
		Valid:           true,
		AccountID:       identity.AccountID,
		AccountName:     identity.AccountName,
		Arn:             identity.Arn,
		AccessKeyID:     creds.AccessKeyID,
		SecretAccessKey: creds.SecretAccessKey,
		SessionToken:    creds.SessionToken,
		Region:          cfg.Region,
	}
}

// StartAwsSSO kicks off an SSO device-authorization flow and returns
// the verification URI + user/device codes for the UI to display.
func StartAwsSSO(ctx context.Context, req SSOStartRequest) SSOStartResponse {
	if req.StartURL == "" {
		return SSOStartResponse{
			Error: "SSO Start URL is required",
		}
	}

	region := resolveRegion(req.Region)

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return SSOStartResponse{
			Error: fmt.Sprintf("Failed to create AWS config: %v", err),
		}
	}

	oidcClient := ssooidc.NewFromConfig(cfg)

	clientName := "gruntbooks-aws-auth"
	registerResult, err := oidcClient.RegisterClient(ctx, &ssooidc.RegisterClientInput{
		ClientName: aws.String(clientName),
		ClientType: aws.String("public"),
	})
	if err != nil {
		return SSOStartResponse{
			Error: fmt.Sprintf("Failed to register SSO client: %v", err),
		}
	}

	authResult, err := oidcClient.StartDeviceAuthorization(ctx, &ssooidc.StartDeviceAuthorizationInput{
		ClientId:     registerResult.ClientId,
		ClientSecret: registerResult.ClientSecret,
		StartUrl:     aws.String(req.StartURL),
	})
	if err != nil {
		return SSOStartResponse{
			Error: formatSSOError(err, region, req.StartURL),
		}
	}

	verificationUri := aws.ToString(authResult.VerificationUriComplete)
	if verificationUri == "" {
		verificationUri = aws.ToString(authResult.VerificationUri)
	}

	return SSOStartResponse{
		VerificationUri: verificationUri,
		UserCode:        aws.ToString(authResult.UserCode),
		DeviceCode:      aws.ToString(authResult.DeviceCode),
		ClientID:        aws.ToString(registerResult.ClientId),
		ClientSecret:    aws.ToString(registerResult.ClientSecret),
	}
}

// PollAwsSSO polls for the user completing the device-authorization
// flow. When an account/role is provided, the response carries
// credentials on success; otherwise it switches to the
// select_account state so the UI can present a picker.
func PollAwsSSO(ctx context.Context, req SSOPollRequest) SSOPollResponse {
	region := resolveRegion(req.Region)

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return SSOPollResponse{
			Status: SSOPollStatusFailed,
			Error:  fmt.Sprintf("Failed to create AWS config: %v", err),
		}
	}

	oidcClient := ssooidc.NewFromConfig(cfg)

	tokenResult, err := oidcClient.CreateToken(ctx, &ssooidc.CreateTokenInput{
		ClientId:     aws.String(req.ClientID),
		ClientSecret: aws.String(req.ClientSecret),
		DeviceCode:   aws.String(req.DeviceCode),
		GrantType:    aws.String("urn:ietf:params:oauth:grant-type:device_code"),
	})
	if err != nil {
		status, message := classifySSOTokenError(err)
		return SSOPollResponse{
			Status: SSOPollStatus(status),
			Error:  message,
		}
	}

	accessToken := aws.ToString(tokenResult.AccessToken)

	if req.AccountID == "" || req.RoleName == "" {
		ssoClient := sso.NewFromConfig(cfg)
		accountsResult, err := ssoClient.ListAccounts(ctx, &sso.ListAccountsInput{
			AccessToken: aws.String(accessToken),
		})
		if err != nil {
			return SSOPollResponse{
				Status: SSOPollStatusFailed,
				Error:  fmt.Sprintf("Failed to list SSO accounts: %v", err),
			}
		}

		if len(accountsResult.AccountList) == 0 {
			return SSOPollResponse{
				Status: SSOPollStatusFailed,
				Error:  "No accounts available in SSO",
			}
		}

		if len(accountsResult.AccountList) == 1 {
			account := accountsResult.AccountList[0]
			rolesResult, err := ssoClient.ListAccountRoles(ctx, &sso.ListAccountRolesInput{
				AccessToken: aws.String(accessToken),
				AccountId:   account.AccountId,
			})
			if err != nil || len(rolesResult.RoleList) == 0 {
				return SSOPollResponse{
					Status: SSOPollStatusFailed,
					Error:  "No roles available for the account",
				}
			}

			if len(rolesResult.RoleList) == 1 {
				req.AccountID = aws.ToString(account.AccountId)
				req.RoleName = aws.ToString(rolesResult.RoleList[0].RoleName)
			} else {
				return SSOPollResponse{
					Status:      SSOPollStatusSelectAccount,
					AccessToken: accessToken,
					Accounts:    convertToSSOAccounts(accountsResult.AccountList),
				}
			}
		} else {
			return SSOPollResponse{
				Status:      SSOPollStatusSelectAccount,
				AccessToken: accessToken,
				Accounts:    convertToSSOAccounts(accountsResult.AccountList),
			}
		}
	}

	ssoClient := sso.NewFromConfig(cfg)
	credsResult, err := ssoClient.GetRoleCredentials(ctx, &sso.GetRoleCredentialsInput{
		AccessToken: aws.String(accessToken),
		AccountId:   aws.String(req.AccountID),
		RoleName:    aws.String(req.RoleName),
	})
	if err != nil {
		return SSOPollResponse{
			Status: SSOPollStatusFailed,
			Error:  fmt.Sprintf("Failed to get role credentials: %v", err),
		}
	}

	accessKeyID := aws.ToString(credsResult.RoleCredentials.AccessKeyId)
	secretAccessKey := aws.ToString(credsResult.RoleCredentials.SecretAccessKey)
	sessionToken := aws.ToString(credsResult.RoleCredentials.SessionToken)

	_, identity, err := validateStaticCredentials(ctx, accessKeyID, secretAccessKey, sessionToken, region)
	if err != nil {
		return SSOPollResponse{
			Status: SSOPollStatusFailed,
			Error:  fmt.Sprintf("Failed to validate SSO credentials: %v", err),
		}
	}

	return SSOPollResponse{
		Status:          SSOPollStatusSuccess,
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		SessionToken:    sessionToken,
		AccountID:       identity.AccountID,
		AccountName:     identity.AccountName,
		Arn:             identity.Arn,
	}
}

// ListAwsSSORoles fetches the role list for an SSO account selected
// during the picker step of the device-authorization flow.
func ListAwsSSORoles(ctx context.Context, req SSOListRolesRequest) SSOListRolesResponse {
	if req.AccessToken == "" || req.AccountID == "" {
		return SSOListRolesResponse{
			Error: "Access token and account ID are required",
		}
	}

	region := resolveRegion(req.Region)

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return SSOListRolesResponse{
			Error: fmt.Sprintf("Failed to create AWS config: %v", err),
		}
	}

	ssoClient := sso.NewFromConfig(cfg)
	rolesResult, err := ssoClient.ListAccountRoles(ctx, &sso.ListAccountRolesInput{
		AccessToken: aws.String(req.AccessToken),
		AccountId:   aws.String(req.AccountID),
	})
	if err != nil {
		return SSOListRolesResponse{
			Error: fmt.Sprintf("Failed to list roles: %v", err),
		}
	}

	roles := make([]SSORole, len(rolesResult.RoleList))
	for i, role := range rolesResult.RoleList {
		roles[i] = SSORole{
			RoleName: aws.ToString(role.RoleName),
		}
	}

	return SSOListRolesResponse{Roles: roles}
}

// CompleteAwsSSO exchanges an access token + account/role for
// short-lived role credentials, validating them via STS before
// returning.
func CompleteAwsSSO(ctx context.Context, req SSOCompleteRequest) SSOCompleteResponse {
	if req.AccessToken == "" || req.AccountID == "" || req.RoleName == "" {
		return SSOCompleteResponse{
			Error: "Access token, account ID, and role name are required",
		}
	}

	region := resolveRegion(req.Region)

	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return SSOCompleteResponse{
			Error: fmt.Sprintf("Failed to create AWS config: %v", err),
		}
	}

	ssoClient := sso.NewFromConfig(cfg)
	credsResult, err := ssoClient.GetRoleCredentials(ctx, &sso.GetRoleCredentialsInput{
		AccessToken: aws.String(req.AccessToken),
		AccountId:   aws.String(req.AccountID),
		RoleName:    aws.String(req.RoleName),
	})
	if err != nil {
		return SSOCompleteResponse{
			Error: fmt.Sprintf("Failed to get role credentials: %v", err),
		}
	}

	accessKeyID := aws.ToString(credsResult.RoleCredentials.AccessKeyId)
	secretAccessKey := aws.ToString(credsResult.RoleCredentials.SecretAccessKey)
	sessionToken := aws.ToString(credsResult.RoleCredentials.SessionToken)

	_, identity, err := validateStaticCredentials(ctx, accessKeyID, secretAccessKey, sessionToken, region)
	if err != nil {
		return SSOCompleteResponse{
			Error: fmt.Sprintf("Failed to validate SSO credentials: %v", err),
		}
	}

	return SSOCompleteResponse{
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		SessionToken:    sessionToken,
		AccountID:       identity.AccountID,
		AccountName:     identity.AccountName,
		Arn:             identity.Arn,
	}
}

// CheckAwsRegion asks the Account API whether a region is enabled
// for the caller. Errors (e.g. missing account:GetRegionOptStatus
// permission) degrade to Enabled=true — the user will see the real
// error when they try to use the region.
func CheckAwsRegion(ctx context.Context, req CheckRegionRequest) CheckRegionResponse {
	if req.Region == "" {
		return CheckRegionResponse{
			Error: "Region is required",
		}
	}
	if req.AccessKeyID == "" || req.SecretAccessKey == "" {
		return CheckRegionResponse{
			Error: "Credentials are required",
		}
	}

	creds := credentials.NewStaticCredentialsProvider(
		req.AccessKeyID,
		req.SecretAccessKey,
		req.SessionToken,
	)

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("us-east-1"),
		config.WithCredentialsProvider(creds),
	)
	if err != nil {
		return CheckRegionResponse{
			Enabled: true,
			Error:   fmt.Sprintf("Failed to create AWS config: %v", err),
		}
	}

	accountClient := account.NewFromConfig(cfg)
	result, err := accountClient.GetRegionOptStatus(ctx, &account.GetRegionOptStatusInput{
		RegionName: aws.String(req.Region),
	})
	if err != nil {
		return CheckRegionResponse{Enabled: true}
	}

	switch result.RegionOptStatus {
	case types.RegionOptStatusDisabled:
		return CheckRegionResponse{
			Enabled: false,
			Status:  "disabled",
			Warning: fmt.Sprintf("The region %s is not enabled for your AWS account. Enable it in the AWS Console under Account Settings > AWS Regions, or choose a different default region.", req.Region),
		}
	case types.RegionOptStatusDisabling:
		return CheckRegionResponse{
			Enabled: false,
			Status:  "disabling",
			Warning: fmt.Sprintf("The region %s is currently being disabled for your AWS account.", req.Region),
		}
	case types.RegionOptStatusEnabling:
		return CheckRegionResponse{
			Enabled: false,
			Status:  "enabling",
			Warning: fmt.Sprintf("The region %s is currently being enabled for your AWS account. Please wait a few minutes and try again.", req.Region),
		}
	default:
		return CheckRegionResponse{
			Enabled: true,
			Status:  "enabled",
		}
	}
}

// DetectAwsEnvCredentials reads (prefixed) AWS env vars, validates
// them via STS, and returns metadata only — raw credentials never
// leave this function via the detection path. ConfirmAwsEnvCredentials
// is the companion function that actually registers the credentials
// once the user confirms.
func DetectAwsEnvCredentials(prefix, defaultRegion string) EnvCredentialsResponse {
	result := readAndValidateAwsEnvCredentials(prefix, defaultRegion)

	if result.Error != "" {
		return EnvCredentialsResponse{
			Found: result.Found,
			Valid: result.Valid,
			Error: result.Error,
		}
	}

	return EnvCredentialsResponse{
		Found:           true,
		Valid:           true,
		AccountID:       result.Identity.AccountID,
		AccountName:     result.Identity.AccountName,
		Arn:             result.Identity.Arn,
		Region:          result.Region,
		HasSessionToken: result.SessionToken != "",
		Warning:         result.Warning,
	}
}

// ConfirmAwsEnvCredentials reads + validates (prefixed) AWS env vars
// and, if valid, writes them to the session's environment so the
// exec path inherits them. Returns the credentials back to the caller
// so the frontend can associate them with a specific AwsAuth block.
func ConfirmAwsEnvCredentials(sm *SessionManager, req ConfirmEnvCredentialsRequest) ConfirmEnvCredentialsResponse {
	result := readAndValidateAwsEnvCredentials(req.Prefix, req.DefaultRegion)

	if result.Error != "" {
		return ConfirmEnvCredentialsResponse{
			Found: result.Found,
			Valid: result.Valid,
			Error: result.Error,
		}
	}

	envVars := map[string]string{
		"AWS_ACCESS_KEY_ID":     result.AccessKeyID,
		"AWS_SECRET_ACCESS_KEY": result.SecretAccessKey,
		"AWS_REGION":            result.Region,
		// Always set to clear any stale session token from previous auth.
		"AWS_SESSION_TOKEN": result.SessionToken,
	}

	if err := sm.AppendToEnv(envVars); err != nil {
		return ConfirmEnvCredentialsResponse{
			Found: true,
			Valid: true,
			Error: "Failed to register credentials to session",
		}
	}

	return ConfirmEnvCredentialsResponse{
		Found:           true,
		Valid:           true,
		AccountID:       result.Identity.AccountID,
		AccountName:     result.Identity.AccountName,
		Arn:             result.Identity.Arn,
		Region:          result.Region,
		HasSessionToken: result.SessionToken != "",
		Warning:         result.Warning,
		AccessKeyID:     result.AccessKeyID,
		SecretAccessKey: result.SecretAccessKey,
		SessionToken:    result.SessionToken,
	}
}

// defaultAwsTimeout is the default deadline for individual AWS API
// calls. Callers that need a different budget should build their own
// context before calling into the Ops functions above.
const defaultAwsTimeout = 10 * time.Second

// WithAwsTimeout is a convenience wrapper that builds a timeout
// context for callers (IPC services) that don't thread a request-
// scoped context.
func WithAwsTimeout(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, defaultAwsTimeout)
}
