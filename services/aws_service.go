package services

import (
	"context"
	"fmt"
	"time"

	"github.com/gruntwork-io/runbooks/api"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// AwsService is the Wails IPC wrapper around the AWS handlers in
// the legacy Gin server. Every method corresponds 1:1 to a
// /api/aws/* endpoint so migrating the frontend hook
// (web/src/components/mdx/AwsAuth/hooks/useAwsAuth.ts) is a
// per-method drop-in replacement.
//
// Validate uses the AwsClient port so it stays testable with a fake
// adapter. The SSO + profile methods still reach the SDK directly via
// shared helpers in api/aws_auth_ops.go — the v1 desktop adapter
// already does that work in-process, and a future hosted adapter can
// replace the whole surface by swapping this service for one that
// talks to a tenant-scoped AWS port.
type AwsService struct {
	servers *serverManager
	aws     ports.AwsClient
}

// NewAwsService constructs the AWS service. The AwsClient port is
// injected so tests can substitute a fake, and so a future hosted
// composition root can plug in a tenant-scoped adapter.
func NewAwsService(servers *serverManager, aws ports.AwsClient) *AwsService {
	return &AwsService{servers: servers, aws: aws}
}

// ServiceName satisfies application.ServiceName.
func (s *AwsService) ServiceName() string { return "AwsService" }

// awsIPCTimeout matches the 10s deadline the HTTP handlers use for
// STS / Account / SSO API calls. Pulling it here (rather than
// re-using api.defaultAwsTimeout) keeps the services package free of
// cross-package time constants and makes this knob easy to find.
const awsIPCTimeout = 10 * time.Second

// awsSSOStartTimeout matches the 30s HTTP handler deadline for the
// SSO start flow (the register-client + start-device-auth round trip
// can be slower than a single STS call on cold paths).
const awsSSOStartTimeout = 30 * time.Second

// Validate validates manual AWS credentials (access key ID +
// secret + optional session token + target region). Delegates to the
// core/aws.Validate path via api.ValidateAwsCredentials.
func (s *AwsService) Validate(req api.ValidateCredentialsRequest) (*api.ValidateCredentialsResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), awsIPCTimeout)
	defer cancel()
	resp := api.ValidateAwsCredentials(ctx, s.aws, req)
	return &resp, nil
}

// ProfilesResponse wraps the ProfileInfo list so Wails bindings
// generate a named response type (bindings don't handle anonymous
// objects cleanly).
type ProfilesResponse struct {
	Profiles []api.ProfileInfo `json:"profiles"`
}

// Profiles returns the AWS profiles discovered in ~/.aws/credentials
// and ~/.aws/config on the local machine.
func (s *AwsService) Profiles() (*ProfilesResponse, error) {
	return &ProfilesResponse{Profiles: api.ListAwsProfiles()}, nil
}

// ProfileAuth authenticates using a local AWS profile.
func (s *AwsService) ProfileAuth(req api.ProfileAuthRequest) (*api.ProfileAuthResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), awsIPCTimeout)
	defer cancel()
	resp := api.AuthenticateAwsProfile(ctx, req.Profile)
	return &resp, nil
}

// SsoStart initiates AWS IAM Identity Center device authorization.
// The UI takes the returned VerificationUri + UserCode, opens the
// browser, and polls SsoPoll until the user completes the flow.
func (s *AwsService) SsoStart(req api.SSOStartRequest) (*api.SSOStartResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), awsSSOStartTimeout)
	defer cancel()
	resp := api.StartAwsSSO(ctx, req)
	return &resp, nil
}

// SsoPoll polls for SSO authentication completion. The response's
// Status field drives the UI state machine (pending / failed /
// success / select_account).
func (s *AwsService) SsoPoll(req api.SSOPollRequest) (*api.SSOPollResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), awsIPCTimeout)
	defer cancel()
	resp := api.PollAwsSSO(ctx, req)
	return &resp, nil
}

// SsoListRoles lists roles available for a given SSO account (used
// during the account-picker step after SsoPoll returns
// select_account).
func (s *AwsService) SsoListRoles(req api.SSOListRolesRequest) (*api.SSOListRolesResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), awsIPCTimeout)
	defer cancel()
	resp := api.ListAwsSSORoles(ctx, req)
	return &resp, nil
}

// SsoComplete exchanges an access token + account + role for
// short-lived role credentials, validating them via STS.
func (s *AwsService) SsoComplete(req api.SSOCompleteRequest) (*api.SSOCompleteResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), awsIPCTimeout)
	defer cancel()
	resp := api.CompleteAwsSSO(ctx, req)
	return &resp, nil
}

// CheckRegion asks the Account API whether a region is enabled for
// the caller's account.
func (s *AwsService) CheckRegion(req api.CheckRegionRequest) (*api.CheckRegionResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), awsIPCTimeout)
	defer cancel()
	resp := api.CheckAwsRegion(ctx, req)
	return &resp, nil
}

// EnvCredentials reads (prefixed) AWS credentials from the process
// environment and validates them via STS. Returns only metadata —
// raw credentials never leave the process on the detection path.
// Call ConfirmEnvCredentials to actually register them to the
// session.
func (s *AwsService) EnvCredentials(req api.EnvCredentialsRequest) (*api.EnvCredentialsResponse, error) {
	resp := api.DetectAwsEnvCredentials(req.Prefix, req.DefaultRegion)
	return &resp, nil
}

// ConfirmEnvCredentials reads (prefixed) AWS credentials from the
// process environment, validates them, and writes them to the open
// gruntbook's session environment so exec inherits them. Returns
// the credentials back so the frontend can associate them with a
// specific AwsAuth block (awsAuthId feature).
func (s *AwsService) ConfirmEnvCredentials(req api.ConfirmEnvCredentialsRequest) (*api.ConfirmEnvCredentialsResponse, error) {
	sessions := s.servers.Sessions()
	if sessions == nil {
		return nil, fmt.Errorf("no gruntbook is open")
	}
	resp := api.ConfirmAwsEnvCredentials(sessions, req)
	return &resp, nil
}
