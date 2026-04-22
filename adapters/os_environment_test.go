package adapters

import (
	"testing"
)

func TestOsEnvironment_Get(t *testing.T) {
	env := NewOsEnvironment()

	key := "GRUNTBOOKS_OS_ENV_ADAPTER_TEST_KEY"
	want := "hello-world"
	t.Setenv(key, want)

	got, ok := env.Get(key)
	if !ok {
		t.Fatalf("Get(%q) ok = false, want true", key)
	}
	if got != want {
		t.Errorf("Get(%q) = %q, want %q", key, got, want)
	}

	if _, ok := env.Get("GRUNTBOOKS_OS_ENV_ADAPTER_TEST_MISSING_KEY"); ok {
		t.Errorf("Get missing key reported ok = true, want false")
	}
}

func TestOsEnvironment_GetAll(t *testing.T) {
	env := NewOsEnvironment()

	key := "GRUNTBOOKS_OS_ENV_ADAPTER_TEST_GETALL"
	want := "snapshot-value"
	t.Setenv(key, want)

	snapshot := env.GetAll()
	if got := snapshot[key]; got != want {
		t.Errorf("snapshot[%q] = %q, want %q", key, got, want)
	}

	// Mutating the returned map must not affect subsequent calls.
	snapshot[key] = "mutated"
	second := env.GetAll()
	if got := second[key]; got != want {
		t.Errorf("second snapshot[%q] = %q; want %q (map mutations leaked)", key, got, want)
	}
}
