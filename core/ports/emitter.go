package ports

// Emitter is the port for pushing streaming events out of core/ to
// whichever transport the caller chose. Domain code never writes
// streaming output to stdout/stderr directly; it calls Emit and the
// adapter decides where the event goes.
//
// Adapters: the desktop adapter (future) wraps application.Event.Emit;
// a hosted adapter would wrap SSE or a WebSocket; the CLI uses a
// slog-based adapter; tests use FakeEmitter to record events for
// assertion.
//
// Topic strings are namespaced by subsystem and correlation ID — e.g.
// "exec:<runID>:log", "exec:<runID>:status", "git:<cloneID>:progress".
// Payloads are any JSON-serializable value; the adapter handles
// serialization for its transport.
type Emitter interface {
	Emit(topic string, payload any) error
}
