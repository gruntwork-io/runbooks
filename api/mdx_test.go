package api

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFindFencedCodeBlockRanges(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		expected [][2]int
	}{
		{
			name:     "no fenced blocks",
			content:  "just some text\nwithout any fences",
			expected: nil,
		},
		{
			name: "single backtick fence",
			content: "before\n```\ncode here\n```\nafter",
			expected: [][2]int{{7, 25}}, // from opening ``` to end of closing ``` line (including newline)
		},
		{
			name: "single tilde fence",
			content: "before\n~~~\ncode here\n~~~\nafter",
			expected: [][2]int{{7, 25}},
		},
		{
			name: "indented backtick fence",
			content: "before\n  ```\n  code here\n  ```\nafter",
			expected: [][2]int{{7, 31}},
		},
		{
			name: "indented tilde fence",
			content: "before\n    ~~~\n    code here\n    ~~~\nafter",
			expected: [][2]int{{7, 37}},
		},
		{
			name: "multiple fenced blocks",
			content: "first\n```\nblock1\n```\nmiddle\n~~~\nblock2\n~~~\nlast",
			expected: [][2]int{{6, 21}, {28, 43}},
		},
		{
			name: "mixed fence types",
			content: "start\n```\nbacktick block\n```\nbetween\n~~~\ntilde block\n~~~\nend",
			expected: [][2]int{{6, 29}, {37, 57}},
		},
		{
			name:     "unclosed fence (odd number)",
			content:  "```\ncode",
			expected: nil, // pairs only complete fences
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := FindFencedCodeBlockRanges(tt.content)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestIsInsideFencedCodeBlock(t *testing.T) {
	ranges := [][2]int{{10, 30}, {50, 70}}

	tests := []struct {
		name     string
		position int
		expected bool
	}{
		{"before first block", 5, false},
		{"at start of first block", 10, true},
		{"inside first block", 20, true},
		{"at end of first block (exclusive)", 30, false},
		{"between blocks", 40, false},
		{"at start of second block", 50, true},
		{"inside second block", 60, true},
		{"at end of second block (exclusive)", 70, false},
		{"after all blocks", 80, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := IsInsideFencedCodeBlock(tt.position, ranges)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestIsInsideFencedCodeBlock_EmptyRanges(t *testing.T) {
	assert.False(t, IsInsideFencedCodeBlock(10, nil))
	assert.False(t, IsInsideFencedCodeBlock(10, [][2]int{}))
}

func TestStripFencedCodeBlocks(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		expected string
	}{
		{
			name:     "no fenced blocks",
			content:  "just text",
			expected: "just text",
		},
		{
			name: "single backtick fence",
			content: `before
` + "```" + `
<Command id="example" />
` + "```" + `
after`,
			expected: `before

after`,
		},
		{
			name: "single tilde fence",
			content: `before
~~~
<Command id="example" />
~~~
after`,
			expected: `before

after`,
		},
		{
			name: "indented fence",
			content: `before
  ` + "```" + `
  <Command id="example" />
  ` + "```" + `
after`,
			expected: `before

after`,
		},
		{
			name: "multiple fenced blocks",
			content: `real content
` + "```" + `
<Command id="doc-example1" />
` + "```" + `
more real content
~~~
<Check id="doc-example2" />
~~~
final content`,
			expected: `real content

more real content

final content`,
		},
		{
			name: "preserves real MDX blocks outside fences",
			content: `<Command id="real-block" />
` + "```" + `
<Command id="doc-example" />
` + "```" + `
<Check id="another-real" />`,
			expected: `<Command id="real-block" />

<Check id="another-real" />`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := StripFencedCodeBlocks(tt.content)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestFenceLineRegex(t *testing.T) {
	tests := []struct {
		name    string
		content string
		matches int
	}{
		{"backticks at start", "```\ncode\n```", 2},
		{"tildes at start", "~~~\ncode\n~~~", 2},
		{"indented backticks", "  ```\ncode\n  ```", 2},
		{"indented tildes", "    ~~~\ncode\n    ~~~", 2},
		{"mixed", "```\ncode\n```\n~~~\nmore\n~~~", 4},
		{"no fences", "just text", 0},
		{"backticks not at line start", "text ```code```", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			matches := FenceLineRegex.FindAllStringIndex(tt.content, -1)
			assert.Equal(t, tt.matches, len(matches))
		})
	}
}
