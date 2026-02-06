package api

import (
	"testing"
)

func TestStripANSI(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "no ANSI codes",
			input: "Hello, World!",
			want:  "Hello, World!",
		},
		{
			name:  "simple color code (red)",
			input: "\x1b[31mRed text\x1b[0m",
			want:  "Red text",
		},
		{
			name:  "multiple color codes",
			input: "\x1b[32mGreen\x1b[0m and \x1b[34mBlue\x1b[0m",
			want:  "Green and Blue",
		},
		{
			name:  "bold and reset",
			input: "\x1b[1mBold\x1b[0m Normal",
			want:  "Bold Normal",
		},
		{
			name:  "cursor movement",
			input: "\x1b[2K\x1b[1GProgress: 50%",
			want:  "Progress: 50%",
		},
		{
			name:  "256 color code",
			input: "\x1b[38;5;196mBright Red\x1b[0m",
			want:  "Bright Red",
		},
		{
			name:  "RGB color code",
			input: "\x1b[38;2;255;0;0mTrue Red\x1b[0m",
			want:  "True Red",
		},
		{
			name:  "git progress output style",
			input: "Receiving objects:  50% (100/200)\x1b[K",
			want:  "Receiving objects:  50% (100/200)",
		},
		{
			name:  "OSC title sequence",
			input: "\x1b]0;Terminal Title\x07Some text",
			want:  "Some text",
		},
		{
			name:  "OSC with ST terminator",
			input: "\x1b]0;Title\x1b\\Text",
			want:  "Text",
		},
		{
			name:  "hyperlink sequence",
			input: "\x1b]8;;https://example.com\x07Link\x1b]8;;\x07",
			want:  "Link",
		},
		{
			name:  "empty string",
			input: "",
			want:  "",
		},
		{
			name:  "only ANSI codes",
			input: "\x1b[31m\x1b[0m",
			want:  "",
		},
		{
			name:  "npm style progress",
			input: "\x1b[2K\x1b[1A\x1b[2K⠸ reify:lodash: timing reify",
			want:  "⠸ reify:lodash: timing reify",
		},
		{
			name:  "tput sgr0 reset sequence",
			input: "\x1b[31mRed text\x1b(B\x1b[m",
			want:  "Red text",
		},
		{
			name:  "character set designation sequences",
			input: "Hello\x1b(B\x1b)0World",
			want:  "HelloWorld",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripANSI(tt.input)
			if got != tt.want {
				t.Errorf("stripANSI() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPTYSupported(t *testing.T) {
	// This test just verifies the function runs without panicking
	// and returns a boolean (actual value depends on OS)
	result := ptySupported()
	t.Logf("ptySupported() = %v", result)

	// On non-Windows, it should be true
	// We can't easily test Windows behavior from non-Windows
}
