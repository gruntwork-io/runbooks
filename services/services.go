package services

import (
	"github.com/gruntwork-io/runbooks/adapters"
	"github.com/gruntwork-io/runbooks/core/ports"
)

// Services is the bundle of Wails-IPC services registered with the
// desktop application. Sibling services share state through private
// package-level fields (e.g. the serverManager that tracks the
// currently-open gruntbook) so callers can't accidentally construct
// services with divergent views of that state.
//
// This container grows across the M3–M5 migration; for each HTTP
// endpoint that becomes an IPC method, a new service lands here.
type Services struct {
	Welcome        *WelcomeService
	Telemetry      *TelemetryService
	File           *FileService
	Boilerplate    *BoilerplateService
	Tf             *TfService
	GeneratedFiles *GeneratedFilesService
	Workspace      *WorkspaceService
	Exec           *ExecService
	Aws            *AwsService
	GitHub         *GitHubService
	Git            *GitService
	Watcher        *WatcherService
	Session        *SessionService
	Runbook        *RunbookService

	// emitter is the transport services push streaming events through
	// (exec logs, git clone progress, watcher notifications). Stored
	// on the container so M4 streaming services pick it up when they
	// land without another signature change on NewServices.
	emitter ports.Emitter
}

// NewServices constructs every Wails-IPC service with a shared
// serverManager so they all see the same currently-open gruntbook.
// initialPath is the CLI argument from `gruntbooks desktop PATH`;
// empty means "show Welcome". emitter is the transport for streaming
// events (exec logs, clone progress, watcher notifications); M3
// services ignore it, but M4+ streaming services need it at
// construction, so the container carries it through.
func NewServices(initialPath string, emitter ports.Emitter) (*Services, error) {
	recent, err := newRecentStore()
	if err != nil {
		return nil, err
	}

	servers := &serverManager{}

	welcome := &WelcomeService{
		servers:     servers,
		recent:      recent,
		initialPath: initialPath,
	}

	return &Services{
		Welcome:        welcome,
		Telemetry:      NewTelemetryService(),
		File:           &FileService{servers: servers},
		Boilerplate:    &BoilerplateService{servers: servers},
		Tf:             &TfService{servers: servers},
		GeneratedFiles: &GeneratedFilesService{servers: servers},
		Workspace:      &WorkspaceService{servers: servers},
		Exec:           NewExecService(servers, emitter),
		Aws:            NewAwsService(servers, adapters.NewSdkAwsClient()),
		GitHub:         NewGitHubService(servers, adapters.NewHttpGitHubClient()),
		Git:            NewGitService(servers, emitter),
		Watcher:        NewWatcherService(emitter),
		Session:        &SessionService{servers: servers},
		Runbook:        &RunbookService{servers: servers},
		emitter:        emitter,
	}, nil
}
