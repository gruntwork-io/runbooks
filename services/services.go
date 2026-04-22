package services

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
}

// NewServices constructs every Wails-IPC service with a shared
// serverManager so they all see the same currently-open gruntbook.
// initialPath is the CLI argument from `gruntbooks desktop PATH`;
// empty means "show Welcome".
func NewServices(initialPath string) (*Services, error) {
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
	}, nil
}
