package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// ExecRunConfig bundles the non-per-request inputs RunExec needs:
// the registry/gruntbook it resolves executables against, the session
// it inherits env/workdir from, and the output paths captured files
// land in. IPC and HTTP callers populate this from their composition
// root (serverManager config + resolved session) before calling RunExec.
type ExecRunConfig struct {
	Registry      *ExecutableRegistry
	GruntbookPath string
	UseRegistry   bool
	WorkingDir    string
	CliOutputPath string
	Sessions      *SessionManager
	ExecCtx       *SessionExecContext
}

// ExecRunResources bundles the temp resources RunExecCore created for
// an in-flight run. RunExecStart returns these synchronously; the
// goroutine that RunExecStart launches (or the caller itself, if it
// drives execution inline) is responsible for calling Cleanup() once
// streamExecutionOutput has sent the done event.
type ExecRunResources struct {
	scriptSetup    *ScriptSetup
	filesDir       string
	outputFilePath string
}

func (r *ExecRunResources) Cleanup() {
	if r == nil {
		return
	}
	if r.filesDir != "" {
		_ = os.RemoveAll(r.filesDir)
	}
	if r.outputFilePath != "" {
		_ = os.Remove(r.outputFilePath)
	}
	if r.scriptSetup != nil {
		r.scriptSetup.Cleanup()
	}
}

// RunExecPrepare does the synchronous setup shared by both the HTTP
// handler and the IPC ExecService: executable lookup, template
// rendering, temp-dir creation, interpreter selection. Returns a
// resources bundle the caller must Cleanup(), plus the cmdConfig
// ready to feed into startCommandExecution.
//
// Returning early on setup errors before execution starts (as opposed
// to emitting them through the sink) matches today's Gin behavior —
// the frontend receives a conventional error response rather than a
// half-streamed SSE that opens with an error event.
func RunExecPrepare(req ExecRequest, cfg ExecRunConfig) (*ExecRunResources, execCommandConfig, error) {
	executable, execErr := getExecutable(cfg.Registry, cfg.GruntbookPath, cfg.UseRegistry, req)
	if execErr != nil {
		return nil, execCommandConfig{}, fmt.Errorf("%s", execErr.message)
	}
	scriptContent, err := prepareScriptContent(executable, req.TemplateVarValues)
	if err != nil {
		return nil, execCommandConfig{}, err
	}
	filesDir, err := os.MkdirTemp("", "gruntbook-files-*")
	if err != nil {
		return nil, execCommandConfig{}, fmt.Errorf("failed to create files directory: %w", err)
	}
	outputFilePath, err := createOutputFile()
	if err != nil {
		_ = os.RemoveAll(filesDir)
		return nil, execCommandConfig{}, err
	}
	scriptSetup, err := PrepareScriptForExecution(scriptContent, executable.Language)
	if err != nil {
		_ = os.RemoveAll(filesDir)
		_ = os.Remove(outputFilePath)
		return nil, execCommandConfig{}, err
	}

	cmdConfig := execCommandConfig{
		scriptPath:   scriptSetup.ScriptPath,
		interpreter:  scriptSetup.Interpreter,
		args:         scriptSetup.Args,
		execCtx:      cfg.ExecCtx,
		envVars:      req.EnvVarsOverride,
		outputFile:   outputFilePath,
		filesDir:     filesDir,
		workTreePath: cfg.Sessions.GetActiveWorkTreePath(),
	}

	return &ExecRunResources{
		scriptSetup:    scriptSetup,
		filesDir:       filesDir,
		outputFilePath: outputFilePath,
	}, cmdConfig, nil
}

// RunExecStream runs the prepared command and streams output through
// the sink until completion. Blocks until the script exits (or the
// context's deadline/cancel fires); callers that want async behavior
// launch this in a goroutine. Does not clean up res — that's the
// caller's responsibility, sequenced relative to sink.Done() as needed.
func RunExecStream(ctx context.Context, req ExecRequest, cfg ExecRunConfig, res *ExecRunResources, cmdConfig execCommandConfig, sink ExecEventSink) {
	outputChan := make(chan outputLine, 100)
	doneChan := make(chan error, 1)

	usePTY := req.UsePTY == nil || *req.UsePTY
	if err := startCommandExecution(ctx, cmdConfig, usePTY, outputChan, doneChan); err != nil {
		sink.Error(err.Error())
		sink.Done()
		return
	}

	resolvedOutputPath := cfg.CliOutputPath
	if !filepath.IsAbs(cfg.CliOutputPath) {
		resolvedOutputPath = filepath.Join(cfg.WorkingDir, cfg.CliOutputPath)
	}

	envCapture := &envCaptureConfig{
		scriptSetup:    res.scriptSetup,
		sessionManager: cfg.Sessions,
		execCtx:        cfg.ExecCtx,
	}
	streamExecutionOutput(sink, outputChan, doneChan, ctx, res.outputFilePath, res.filesDir, resolvedOutputPath, envCapture)
}
