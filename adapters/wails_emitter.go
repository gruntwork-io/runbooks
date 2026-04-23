package adapters

import (
	"github.com/gruntwork-io/runbooks/core/ports"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// WailsEmitter pushes domain events out over the Wails v3 custom-event
// bus so the React frontend can subscribe via Events.On(topic, cb).
// Topic strings are opaque to Wails — they're matched byte-for-byte
// against the name passed to Events.On — so domain code uses the same
// "exec:<runID>:log" convention documented on ports.Emitter.
//
// We resolve the app via application.Get() at emit time rather than
// holding a captured reference. That lets services construct with the
// emitter before application.New() has been called (construction order
// in desktop/app.go builds services first, then the app), while still
// doing the right thing at emit time — by the time any service method
// fires an event, Wails' IPC bus is up and Get() returns the running
// app. A nil app (emit before construction) silently drops the event
// rather than crashing, matching NoopEmitter semantics.
//
// app.Event.Emit accepts variadic data. We always pass a single payload
// so Wails sets event.Data = payload (not a length-1 slice), which
// matches the shape the TypeScript Events.On callback receives.
type WailsEmitter struct{}

func NewWailsEmitter() WailsEmitter { return WailsEmitter{} }

// Emit returns nil unconditionally: app.Event.Emit reports serialization
// failures through Wails' global error handler, not its return value
// (the bool indicates hook-cancellation, which domain code doesn't care
// about). Matching that, the port signature's error return is reserved
// for transports that can actually fail synchronously.
func (WailsEmitter) Emit(topic string, payload any) error {
	app := application.Get()
	if app == nil {
		return nil
	}
	app.Event.Emit(topic, payload)
	return nil
}

var _ ports.Emitter = WailsEmitter{}
