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

func TestDetectInterpreter(t *testing.T) {
	tests := []struct {
		name         string
		script       string
		providedLang string
		wantInterp   string
		wantArgs     []string
	}{
		{
			name:         "explicit language overrides shebang",
			script:       "#!/bin/bash\necho hello",
			providedLang: "python3",
			wantInterp:   "python3",
			wantArgs:     []string{},
		},
		{
			name:         "env shebang - python3",
			script:       "#!/usr/bin/env python3\nprint('hello')",
			providedLang: "",
			wantInterp:   "python3",
			wantArgs:     []string{},
		},
		{
			name:         "env shebang - python3 with args",
			script:       "#!/usr/bin/env python3 -u\nprint('hello')",
			providedLang: "",
			wantInterp:   "python3",
			wantArgs:     []string{"-u"},
		},
		{
			name:         "env shebang - node",
			script:       "#!/usr/bin/env node\nconsole.log('hello')",
			providedLang: "",
			wantInterp:   "node",
			wantArgs:     []string{},
		},
		{
			name:         "direct path shebang - bash",
			script:       "#!/bin/bash\necho hello",
			providedLang: "",
			wantInterp:   "bash",
			wantArgs:     []string{},
		},
		{
			name:         "direct path shebang - bash with args",
			script:       "#!/bin/bash -e\necho hello",
			providedLang: "",
			wantInterp:   "bash",
			wantArgs:     []string{"-e"},
		},
		{
			name:         "direct path shebang - sh",
			script:       "#!/bin/sh\necho hello",
			providedLang: "",
			wantInterp:   "sh",
			wantArgs:     []string{},
		},
		{
			name:         "direct path shebang - zsh",
			script:       "#!/usr/bin/zsh\necho hello",
			providedLang: "",
			wantInterp:   "zsh",
			wantArgs:     []string{},
		},
		{
			name:         "direct path shebang - python3",
			script:       "#!/usr/bin/python3\nprint('hello')",
			providedLang: "",
			wantInterp:   "python3",
			wantArgs:     []string{},
		},
		{
			name:         "no shebang defaults to bash",
			script:       "echo hello",
			providedLang: "",
			wantInterp:   "bash",
			wantArgs:     []string{},
		},
		{
			name:         "empty script defaults to bash",
			script:       "",
			providedLang: "",
			wantInterp:   "bash",
			wantArgs:     []string{},
		},
		{
			name:         "shebang with extra whitespace",
			script:       "#!/usr/bin/env python3  \nprint('hello')",
			providedLang: "",
			wantInterp:   "python3",
			wantArgs:     []string{},
		},
		{
			name:         "shebang only (no trailing newline)",
			script:       "#!/bin/bash",
			providedLang: "",
			wantInterp:   "bash",
			wantArgs:     []string{},
		},
		{
			name:         "multiple args after interpreter",
			script:       "#!/bin/bash -e -x -u\necho hello",
			providedLang: "",
			wantInterp:   "bash",
			wantArgs:     []string{"-e", "-x", "-u"},
		},
		{
			name:         "env with multiple args",
			script:       "#!/usr/bin/env python3 -u -W ignore\nprint('hello')",
			providedLang: "",
			wantInterp:   "python3",
			wantArgs:     []string{"-u", "-W", "ignore"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotInterp, gotArgs := detectInterpreter(tt.script, tt.providedLang)
			
			if gotInterp != tt.wantInterp {
				t.Errorf("detectInterpreter() interpreter = %v, want %v", gotInterp, tt.wantInterp)
			}
			
			if len(gotArgs) != len(tt.wantArgs) {
				t.Errorf("detectInterpreter() args length = %v, want %v", len(gotArgs), len(tt.wantArgs))
				return
			}
			
			for i := range gotArgs {
				if gotArgs[i] != tt.wantArgs[i] {
					t.Errorf("detectInterpreter() args[%d] = %v, want %v", i, gotArgs[i], tt.wantArgs[i])
				}
			}
		})
	}
}

