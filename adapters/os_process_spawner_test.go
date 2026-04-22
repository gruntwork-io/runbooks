package adapters

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gruntwork-io/runbooks/core/ports"
)

func TestOsProcessSpawner_RunSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("echo semantics differ on Windows; adapter behavior is the same but this test uses POSIX /bin/echo")
	}

	spawner := NewOsProcessSpawner()
	ctx := context.Background()

	result, err := spawner.Run(ctx, ports.ProcessRequest{
		Name: "/bin/echo",
		Args: []string{"hello"},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("ExitCode = %d, want 0", result.ExitCode)
	}
	if got := strings.TrimSpace(string(result.Stdout)); got != "hello" {
		t.Errorf("Stdout = %q, want %q", got, "hello")
	}
}

func TestOsProcessSpawner_RunNonZeroExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses POSIX /bin/sh")
	}

	spawner := NewOsProcessSpawner()
	ctx := context.Background()

	// A non-zero exit is NOT an error; it's reflected in ExitCode.
	result, err := spawner.Run(ctx, ports.ProcessRequest{
		Name: "/bin/sh",
		Args: []string{"-c", "exit 7"},
	})
	if err != nil {
		t.Fatalf("Run returned err for non-zero exit: %v", err)
	}
	if result.ExitCode != 7 {
		t.Errorf("ExitCode = %d, want 7", result.ExitCode)
	}
}

func TestOsProcessSpawner_RunFailsToStart(t *testing.T) {
	spawner := NewOsProcessSpawner()
	ctx := context.Background()

	_, err := spawner.Run(ctx, ports.ProcessRequest{
		Name: "/definitely/not/a/real/binary-xyz",
	})
	if err == nil {
		t.Fatal("Run: want err for missing binary, got nil")
	}
}

func TestOsProcessSpawner_RunContextCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses POSIX /bin/sh sleep")
	}

	spawner := NewOsProcessSpawner()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := spawner.Run(ctx, ports.ProcessRequest{
		Name: "/bin/sh",
		Args: []string{"-c", "sleep 5"},
	})
	if err == nil {
		t.Fatal("Run: want err from cancelled context, got nil")
	}
}

func TestOsProcessSpawner_LookPath(t *testing.T) {
	spawner := NewOsProcessSpawner()

	// sh is present on all POSIX systems we target.
	if runtime.GOOS != "windows" {
		path, err := spawner.LookPath("sh")
		if err != nil {
			t.Fatalf("LookPath(sh): %v", err)
		}
		if path == "" {
			t.Error("LookPath(sh) returned empty path")
		}
	}

	_, err := spawner.LookPath("definitely-not-a-real-binary-xyz-" + t.Name())
	if !errors.Is(err, ports.ErrExecutableNotFound) {
		t.Errorf("LookPath missing binary: err = %v, want ErrExecutableNotFound", err)
	}
}
