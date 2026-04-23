package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gruntwork-io/runbooks/core/ports"
	"golang.org/x/mod/semver"
)

// UpdateService polls the GitHub Releases API on startup and daily
// thereafter to notify the frontend when a newer Gruntbooks version is
// available. Consumers subscribe to the `update:available` topic once
// at boot; the service debounces re-emits so a single version only
// fires once per process lifetime, regardless of how many poll cycles
// observe it.
//
// M5 ships tier-1 auto-update: surface availability, link to the
// release page, and let the user update through their package manager
// or a manual download. In-app install (Sparkle/Squirrel) is deferred.
//
// The service is desktop-only. The legacy browser path (`gruntbooks
// open` → Gin) has no equivalent banner.
type UpdateService struct {
	emitter        ports.Emitter
	currentVersion string
	owner          string
	repo           string
	httpClient     *http.Client

	mu             sync.Mutex
	lastSeenLatest string
}

// UpdateInfo is the payload emitted on `update:available` and returned
// by Check(). Available=false means no newer release is out; the other
// fields are still populated so the frontend can show "Gruntbooks is
// up to date" in a settings view without another round-trip.
type UpdateInfo struct {
	Available      bool   `json:"available"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	ReleaseURL     string `json:"releaseUrl"`
}

// NewUpdateService constructs an UpdateService. currentVersion is the
// build-stamped version string (cmd.Version). Dev builds ("dev",
// empty, or non-semver strings) skip polling — a developer running
// `task desktop:dev` shouldn't see a banner telling them to download
// the latest release.
func NewUpdateService(emitter ports.Emitter, currentVersion string) *UpdateService {
	return &UpdateService{
		emitter:        emitter,
		currentVersion: currentVersion,
		owner:          "gruntwork-io",
		repo:           "runbooks",
		httpClient:     &http.Client{Timeout: 10 * time.Second},
	}
}

// ServiceName satisfies application.ServiceName.
func (s *UpdateService) ServiceName() string { return "UpdateService" }

const (
	// updateCheckInitialDelay is how long after boot the first check
	// fires. Short enough that users see the banner early in the
	// session, long enough that it doesn't compete with the initial
	// runbook load for network bandwidth.
	updateCheckInitialDelay = 30 * time.Second

	// updateCheckInterval is the gap between successive checks on a
	// long-running session. Daily is enough — releases ship on the
	// order of weeks, not hours.
	updateCheckInterval = 24 * time.Hour
)

// Check performs a single release lookup and returns the result. Safe
// to call from the frontend (e.g. a "Check for updates" menu item in
// a future milestone); does not emit the `update:available` event —
// callers that want the banner behaviour should use StartAutoCheck.
func (s *UpdateService) Check(ctx context.Context) (*UpdateInfo, error) {
	return s.check(ctx)
}

// RunAutoCheck kicks off the background poll loop. Blocks until ctx
// is cancelled, so callers should run it in a goroutine. Failures
// (network, parse, rate limit) are logged and swallowed — the banner
// is nice-to-have and must never take down the app.
//
// This is a package-level function rather than a method so the Wails
// bindings generator doesn't expose it over IPC. The frontend has no
// business kicking off the poll loop — desktop/app.go owns that
// lifecycle.
func RunAutoCheck(ctx context.Context, s *UpdateService) {
	if !s.isReleaseVersion() {
		slog.Info("update check skipped: dev build", "version", s.currentVersion)
		return
	}

	timer := time.NewTimer(updateCheckInitialDelay)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.checkAndEmit(ctx)
			timer.Reset(updateCheckInterval)
		}
	}
}

// checkAndEmit runs one poll and fires `update:available` if a newer
// version is available AND hasn't been emitted before this session.
// Deduping by version string means restarting Gruntbooks is the only
// way to re-see a banner for the same release.
func (s *UpdateService) checkAndEmit(ctx context.Context) {
	info, err := s.check(ctx)
	if err != nil {
		slog.Warn("update check failed", "error", err)
		return
	}
	if !info.Available {
		return
	}

	s.mu.Lock()
	alreadyEmitted := s.lastSeenLatest == info.LatestVersion
	s.lastSeenLatest = info.LatestVersion
	s.mu.Unlock()

	if alreadyEmitted {
		return
	}

	slog.Info("update available", "current", info.CurrentVersion, "latest", info.LatestVersion)
	_ = s.emitter.Emit("update:available", info)
}

// githubRelease matches the subset of the GitHub Releases API response
// we actually consume. https://docs.github.com/en/rest/releases/releases
type githubRelease struct {
	TagName    string `json:"tag_name"`
	HTMLURL    string `json:"html_url"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// check hits the /releases/latest endpoint and compares against the
// current version. A 404 means the repo has no published releases yet
// and is treated as "no update" rather than an error — expected
// pre-1.0 state, not worth pestering the log about.
func (s *UpdateService) check(ctx context.Context) (*UpdateInfo, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", s.owner, s.repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch latest release: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusNotFound {
		return &UpdateInfo{
			Available:      false,
			CurrentVersion: s.currentVersion,
		}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d from github releases api", resp.StatusCode)
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("decode release: %w", err)
	}
	if release.Draft || release.Prerelease {
		return &UpdateInfo{
			Available:      false,
			CurrentVersion: s.currentVersion,
			LatestVersion:  release.TagName,
			ReleaseURL:     release.HTMLURL,
		}, nil
	}

	currentCanonical := normalizeSemver(s.currentVersion)
	latestCanonical := normalizeSemver(release.TagName)
	if currentCanonical == "" || latestCanonical == "" {
		return nil, errors.New("semver parse failed for current or latest version")
	}

	return &UpdateInfo{
		Available:      semver.Compare(latestCanonical, currentCanonical) > 0,
		CurrentVersion: s.currentVersion,
		LatestVersion:  release.TagName,
		ReleaseURL:     release.HTMLURL,
	}, nil
}

// isReleaseVersion reports whether the stamped Version looks like a
// real release tag. Dev builds and unstamped binaries skip the check
// to avoid bogus "update available" banners during development.
func (s *UpdateService) isReleaseVersion() bool {
	return normalizeSemver(s.currentVersion) != ""
}

// normalizeSemver returns a canonical "vMAJOR.MINOR.PATCH" string or
// empty if the input isn't a parseable semver. golang.org/x/mod/semver
// requires the leading "v" and rejects anything else; we prepend when
// the build tooling stamps a bare "1.2.3" version.
func normalizeSemver(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	if !semver.IsValid(v) {
		return ""
	}
	return semver.Canonical(v)
}
