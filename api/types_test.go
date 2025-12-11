package api

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestFlexibleBool_UnmarshalJSON tests that FlexibleBool correctly handles both
// boolean and string values from JSON.
//
// MDX/JSX props are serialized differently depending on syntax:
//   - generateFile={true}  → JSX expression → JSON boolean: true
//   - generateFile="true"  → JSX string attr → JSON string: "true"
//
// React handles the MDX → JSON conversion; this test covers the JSON → Go conversion.
// Runbook authors often mistakenly use the string syntax, so FlexibleBool accepts both.
func TestFlexibleBool_UnmarshalJSON(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		expected    bool
		expectError bool
	}{
		// Boolean values
		{
			name:     "boolean true",
			input:    `true`,
			expected: true,
		},
		{
			name:     "boolean false",
			input:    `false`,
			expected: false,
		},

		// String values - truthy
		{
			name:     "string lowercase true",
			input:    `"true"`,
			expected: true,
		},
		{
			name:     "string uppercase TRUE",
			input:    `"TRUE"`,
			expected: true,
		},
		{
			name:     "string titlecase True",
			input:    `"True"`,
			expected: true,
		},
		{
			name:     "string 1",
			input:    `"1"`,
			expected: true,
		},

		// String values - falsy
		{
			name:     "string lowercase false",
			input:    `"false"`,
			expected: false,
		},
		{
			name:     "string uppercase FALSE",
			input:    `"FALSE"`,
			expected: false,
		},
		{
			name:     "string titlecase False",
			input:    `"False"`,
			expected: false,
		},
		{
			name:     "string 0",
			input:    `"0"`,
			expected: false,
		},
		{
			name:     "empty string",
			input:    `""`,
			expected: false,
		},

		// Invalid values
		{
			name:        "invalid string",
			input:       `"yes"`,
			expectError: true,
		},
		{
			name:        "invalid string random",
			input:       `"random"`,
			expectError: true,
		},
		{
			name:        "number (not string)",
			input:       `123`,
			expectError: true,
		},
		{
			name:     "null treated as false",
			input:    `null`,
			expected: false, // Go's json package treats null as zero value for bool
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var fb FlexibleBool
			err := json.Unmarshal([]byte(tt.input), &fb)

			if tt.expectError {
				assert.Error(t, err, "expected error for input: %s", tt.input)
			} else {
				require.NoError(t, err, "unexpected error for input: %s", tt.input)
				assert.Equal(t, tt.expected, bool(fb), "unexpected value for input: %s", tt.input)
			}
		})
	}
}

func TestFlexibleBool_InStruct(t *testing.T) {
	// Test that FlexibleBool works correctly when embedded in a struct (like RenderInlineRequest)
	type TestStruct struct {
		Name    string       `json:"name"`
		Enabled FlexibleBool `json:"enabled"`
	}

	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{
			name:     "boolean in struct",
			input:    `{"name": "test", "enabled": true}`,
			expected: true,
		},
		{
			name:     "string in struct",
			input:    `{"name": "test", "enabled": "true"}`,
			expected: true,
		},
		{
			name:     "missing field defaults to false",
			input:    `{"name": "test"}`,
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var ts TestStruct
			err := json.Unmarshal([]byte(tt.input), &ts)
			require.NoError(t, err)
			assert.Equal(t, tt.expected, bool(ts.Enabled))
		})
	}
}

