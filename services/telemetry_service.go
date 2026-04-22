package services

import "github.com/gruntwork-io/runbooks/api/telemetry"

// TelemetryService exposes the backend-computed telemetry configuration
// (enabled flag, anonymous ID, build version) to the frontend over IPC.
//
// The frontend uses this to decide whether to boot Mixpanel and which
// anonymous identity to register with. In M3 this replaces the
// GET /api/telemetry/config endpoint for desktop callers; browser mode
// continues to hit the HTTP endpoint until M5 removes Gin.
type TelemetryService struct{}

// NewTelemetryService constructs a TelemetryService. No dependencies —
// the underlying telemetry package holds a process-global singleton
// populated at startup by cmd/desktop.go.
func NewTelemetryService() *TelemetryService {
	return &TelemetryService{}
}

// ServiceName provides a friendly name in the Wails runtime logs.
func (s *TelemetryService) ServiceName() string {
	return "TelemetryService"
}

// Config returns the telemetry configuration snapshot. Safe to call
// before the Mixpanel client is initialised; the snapshot reports
// Enabled=false in that case.
func (s *TelemetryService) Config() telemetry.Config {
	return telemetry.GetConfig()
}
