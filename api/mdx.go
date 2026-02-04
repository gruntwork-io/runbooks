package api

import (
	"regexp"
	"strings"
)

// FenceLineRegex matches fence marker lines (``` or ~~~) with optional leading whitespace.
// Use with FindAllStringIndex to find fence positions for pairing.
var FenceLineRegex = regexp.MustCompile(`(?m)^\s*(?:` + "```" + `|~~~)`)

// fencedBlockRegex matches complete fenced code blocks (opening + content + closing).
// Used for stripping entire blocks from content.
var fencedBlockRegex = regexp.MustCompile(`(?m)^\s*(?:` + "```" + `|~~~).*\n(?:.*\n)*?^\s*(?:` + "```" + `|~~~)\s*$`)

// FindFencedCodeBlockRanges finds all fenced code block ranges in the content.
// Returns a slice of [start, end] pairs representing positions inside code blocks.
// This is used to skip components that appear as documentation examples inside code blocks.
func FindFencedCodeBlockRanges(content string) [][2]int {
	var ranges [][2]int

	// Find all fence markers (lines starting with ``` or ~~~)
	// In markdown, fences alternate: open, close, open, close...
	matches := FenceLineRegex.FindAllStringIndex(content, -1)

	// Pair up consecutive fences: [0,1], [2,3], [4,5], etc.
	for i := 0; i+1 < len(matches); i += 2 {
		openStart := matches[i][0]
		closeStart := matches[i+1][0]
		// Find end of closing fence line
		closeEnd := len(content)
		if nl := strings.IndexByte(content[closeStart:], '\n'); nl != -1 {
			closeEnd = closeStart + nl + 1
		}
		ranges = append(ranges, [2]int{openStart, closeEnd})
	}

	return ranges
}

// IsInsideFencedCodeBlock checks if a position is inside any fenced code block.
func IsInsideFencedCodeBlock(position int, codeBlockRanges [][2]int) bool {
	for _, r := range codeBlockRanges {
		if position >= r[0] && position < r[1] {
			return true
		}
	}
	return false
}

// StripFencedCodeBlocks removes fenced code block content from MDX content.
// This prevents false positives when parsing blocks that appear inside documentation examples.
// Matches both ``` and ~~~ fences, with optional leading whitespace.
func StripFencedCodeBlocks(content string) string {
	return fencedBlockRegex.ReplaceAllString(content, "")
}
