package api

import (
	"testing"
)

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

