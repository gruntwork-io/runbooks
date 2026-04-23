package services

import (
	"testing"

	"github.com/gruntwork-io/runbooks/adapters"
)

func TestNormalizeSemver(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"v1.2.3", "v1.2.3"},
		{"1.2.3", "v1.2.3"},
		{"  v1.2.3  ", "v1.2.3"},
		{"v1.2.3-rc.1", "v1.2.3-rc.1"},
		{"v0.1.0", "v0.1.0"},
		{"dev", ""},
		{"", ""},
		{"not-a-version", ""},
	}
	for _, c := range cases {
		if got := normalizeSemver(c.in); got != c.want {
			t.Errorf("normalizeSemver(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsReleaseVersion(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"v1.2.3", true},
		{"1.2.3", true},
		{"dev", false},
		{"", false},
		{"unknown", false},
	}
	for _, c := range cases {
		s := NewUpdateService(adapters.NewNoopEmitter(), c.version)
		if got := s.isReleaseVersion(); got != c.want {
			t.Errorf("isReleaseVersion(%q) = %v, want %v", c.version, got, c.want)
		}
	}
}
