package api

import (
	"bufio"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/zclconf/go-cty/cty"
)

// TofuVariable represents a parsed OpenTofu variable block.
type TofuVariable struct {
	Name         string
	Type         string           // Raw type expression (e.g. "string", "list(string)")
	Description  string
	Default      interface{}
	HasDefault   bool
	Sensitive    bool
	Nullable     bool
	Validations  []TofuValidation
	SourceFile   string
	GroupComment string           // From # @group "Name" comments
}

// TofuValidation represents a validation block within an OpenTofu variable.
type TofuValidation struct {
	Condition    string
	ErrorMessage string
}

// ParseTofuModule reads all .tf files in moduleDir and returns parsed variables.
func ParseTofuModule(moduleDir string) ([]TofuVariable, error) {
	entries, err := os.ReadDir(moduleDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read module directory: %w", err)
	}

	var variables []TofuVariable

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".tf" {
			continue
		}

		filePath := filepath.Join(moduleDir, entry.Name())
		fileVars, err := parseTFFile(filePath, entry.Name())
		if err != nil {
			slog.Warn("Failed to parse .tf file", "file", entry.Name(), "error", err)
			continue
		}
		variables = append(variables, fileVars...)
	}

	if len(variables) == 0 {
		return nil, fmt.Errorf("no variables found in %s", moduleDir)
	}

	return variables, nil
}

// parseTFFile parses a single .tf file and returns its variable blocks.
func parseTFFile(filePath, fileName string) ([]TofuVariable, error) {
	src, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", filePath, err)
	}

	file, diags := hclsyntax.ParseConfig(src, fileName, hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		return nil, fmt.Errorf("failed to parse HCL in %s: %s", fileName, diags.Error())
	}

	body, ok := file.Body.(*hclsyntax.Body)
	if !ok {
		return nil, fmt.Errorf("unexpected body type in %s", fileName)
	}

	// Pre-scan for @group comments
	groupComments := extractGroupComments(src)

	var variables []TofuVariable

	for _, block := range body.Blocks {
		if block.Type != "variable" || len(block.Labels) == 0 {
			continue
		}

		v := TofuVariable{
			Name:       block.Labels[0],
			SourceFile: fileName,
			Nullable:   false, // default
		}

		// Check for @group comment
		if group, ok := groupComments[block.DefRange().Start.Line]; ok {
			v.GroupComment = group
		}

		// Parse attributes from the variable block body
		varBody := block.Body

		// Type
		if attr, exists := varBody.Attributes["type"]; exists {
			v.Type = extractTypeExpression(src, attr.Expr.Range())
		}

		// Description
		if attr, exists := varBody.Attributes["description"]; exists {
			val, diags := attr.Expr.Value(nil)
			if !diags.HasErrors() && val.Type() == cty.String {
				v.Description = val.AsString()
			}
		}

		// Default
		if attr, exists := varBody.Attributes["default"]; exists {
			v.HasDefault = true
			v.Default = ctyValueToInterface(attr.Expr, src)
		}

		// Sensitive
		if attr, exists := varBody.Attributes["sensitive"]; exists {
			val, diags := attr.Expr.Value(nil)
			if !diags.HasErrors() && val.Type() == cty.Bool {
				v.Sensitive = val.True()
			}
		}

		// Nullable
		if attr, exists := varBody.Attributes["nullable"]; exists {
			val, diags := attr.Expr.Value(nil)
			if !diags.HasErrors() && val.Type() == cty.Bool {
				v.Nullable = val.True()
			}
		}

		// Validation blocks
		for _, subBlock := range varBody.Blocks {
			if subBlock.Type != "validation" {
				continue
			}
			tv := TofuValidation{}
			if attr, exists := subBlock.Body.Attributes["condition"]; exists {
				tv.Condition = extractSourceRange(src, attr.Expr.Range())
			}
			if attr, exists := subBlock.Body.Attributes["error_message"]; exists {
				val, diags := attr.Expr.Value(nil)
				if !diags.HasErrors() && val.Type() == cty.String {
					tv.ErrorMessage = val.AsString()
				}
			}
			v.Validations = append(v.Validations, tv)
		}

		variables = append(variables, v)
	}

	return variables, nil
}

// extractGroupComments scans source for "# @group "Name"" comments and maps
// line numbers to group names. The comment applies to the next variable block.
func extractGroupComments(src []byte) map[int]string {
	groups := make(map[int]string)
	re := regexp.MustCompile(`#\s*@group\s+"([^"]+)"`)

	scanner := bufio.NewScanner(strings.NewReader(string(src)))
	lineNum := 0
	var pendingGroup string

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())

		if match := re.FindStringSubmatch(line); match != nil {
			pendingGroup = match[1]
			continue
		}

		// If we have a pending group and hit a variable block, associate it
		if pendingGroup != "" && strings.HasPrefix(line, "variable ") {
			groups[lineNum] = pendingGroup
			pendingGroup = ""
		} else if pendingGroup != "" && line != "" && !strings.HasPrefix(line, "#") {
			// Non-empty, non-comment line that isn't a variable — reset
			pendingGroup = ""
		}
	}

	return groups
}

// extractTypeExpression extracts the raw type expression text from source.
func extractTypeExpression(src []byte, rng hcl.Range) string {
	return strings.TrimSpace(extractSourceRange(src, rng))
}

// extractSourceRange extracts the raw source text for a given HCL range.
func extractSourceRange(src []byte, rng hcl.Range) string {
	start := posToOffset(src, rng.Start)
	end := posToOffset(src, rng.End)
	if start < 0 || end < 0 || start >= end || end > len(src) {
		return ""
	}
	return string(src[start:end])
}

// posToOffset converts an hcl.Pos (1-indexed line/column) to a byte offset.
func posToOffset(src []byte, pos hcl.Pos) int {
	if pos.Byte >= 0 {
		return pos.Byte
	}
	line := 1
	col := 1
	for i, b := range src {
		if line == pos.Line && col == pos.Column {
			return i
		}
		if b == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return -1
}

// ctyValueToInterface converts an HCL expression to a Go interface{}.
// For simple literals it evaluates the expression; for complex types it
// extracts the raw source text.
func ctyValueToInterface(expr hcl.Expression, src []byte) interface{} {
	val, diags := expr.Value(nil)
	if diags.HasErrors() {
		// Fall back to source text for complex expressions
		return extractSourceRange(src, expr.Range())
	}

	return ctyToGo(val)
}

// ctyToGo converts a cty.Value to a native Go value.
func ctyToGo(val cty.Value) interface{} {
	if val.IsNull() {
		return nil
	}

	ty := val.Type()

	switch {
	case ty == cty.String:
		return val.AsString()
	case ty == cty.Number:
		bf := val.AsBigFloat()
		if bf.IsInt() {
			i, _ := bf.Int64()
			return i
		}
		f, _ := bf.Float64()
		return f
	case ty == cty.Bool:
		return val.True()
	case ty.IsListType() || ty.IsSetType() || ty.IsTupleType():
		var result []interface{}
		it := val.ElementIterator()
		for it.Next() {
			_, v := it.Element()
			result = append(result, ctyToGo(v))
		}
		if result == nil {
			return []interface{}{}
		}
		return result
	case ty.IsMapType() || ty.IsObjectType():
		result := make(map[string]interface{})
		it := val.ElementIterator()
		for it.Next() {
			k, v := it.Element()
			result[k.AsString()] = ctyToGo(v)
		}
		return result
	default:
		return nil
	}
}

// MapToBoilerplateConfig converts OpenTofu variables to a BoilerplateConfig.
func MapToBoilerplateConfig(vars []TofuVariable) *BoilerplateConfig {
	config := &BoilerplateConfig{
		Variables: make([]BoilerplateVariable, 0, len(vars)),
	}

	for _, v := range vars {
		bv := BoilerplateVariable{
			Name:        v.Name,
			Description: v.Description,
			Type:        MapTofuType(v.Type),
			Default:     v.Default,
			Required:    !v.HasDefault && !v.Nullable,
		}

		// Process validations
		validations, options, descSuffix := processValidations(v)

		if len(options) > 0 {
			bv.Type = VarTypeEnum
			bv.Options = options
			// If no explicit default, default to the first option so the
			// dropdown doesn't start blank and trigger required validation.
			if !v.HasDefault && len(options) > 0 {
				bv.Default = options[0]
			}
		}

		if descSuffix != "" {
			if bv.Description != "" {
				bv.Description += " " + descSuffix
			} else {
				bv.Description = descSuffix
			}
		}

		// Add required validation if no default and not nullable
		if bv.Required {
			validations = append([]ValidationRule{{
				Type:    ValidationRequired,
				Message: "This field is required",
			}}, validations...)
		}

		if len(validations) > 0 {
			bv.Validations = validations
		}

		// Handle x-schema for object types
		if schema := extractObjectSchema(v.Type); schema != nil {
			bv.Schema = schema
		}

		// Set section name from group comment
		if v.GroupComment != "" {
			bv.SectionName = v.GroupComment
		}

		// Handle tuple type: extract element types as schema with numeric keys
		if tupleSchema := extractTupleSchema(v.Type); tupleSchema != nil {
			bv.Schema = tupleSchema
		}

		config.Variables = append(config.Variables, bv)
	}

	// Build sections and back-propagate section names to variables
	config.Sections = buildSections(vars)

	// Populate SectionName on each variable from the computed sections.
	// This ensures x-section is written to boilerplate.yml even for
	// filename-based and prefix-based groupings (not just @group comments).
	sectionByVar := make(map[string]string)
	for _, s := range config.Sections {
		for _, varName := range s.Variables {
			sectionByVar[varName] = s.Name
		}
	}
	for i := range config.Variables {
		if name, ok := sectionByVar[config.Variables[i].Name]; ok && config.Variables[i].SectionName == "" {
			config.Variables[i].SectionName = name
		}
	}

	return config
}

// MapTofuType converts an OpenTofu type expression to a BoilerplateVarType.
func MapTofuType(typeExpr string) BoilerplateVarType {
	typeExpr = strings.TrimSpace(typeExpr)

	switch {
	case typeExpr == "" || typeExpr == "any" || typeExpr == "string":
		return VarTypeString
	case typeExpr == "number":
		return VarTypeInt
	case typeExpr == "bool":
		return VarTypeBool
	case strings.HasPrefix(typeExpr, "list(") || strings.HasPrefix(typeExpr, "set(") || strings.HasPrefix(typeExpr, "tuple("):
		return VarTypeList
	case strings.HasPrefix(typeExpr, "map(") || strings.HasPrefix(typeExpr, "object("):
		return VarTypeMap
	case strings.HasPrefix(typeExpr, "optional("):
		inner := typeExpr[len("optional(") : len(typeExpr)-1]
		return MapTofuType(inner)
	default:
		return VarTypeString
	}
}

// extractTupleSchema parses a tuple([T1, T2, ...]) type expression into a schema map
// with numeric keys: {"0": "string", "1": "number"}.
// Returns nil if the type is not a tuple or has no elements.
func extractTupleSchema(typeExpr string) map[string]string {
	typeExpr = strings.TrimSpace(typeExpr)
	if !strings.HasPrefix(typeExpr, "tuple(") {
		return nil
	}

	// Extract inner content: tuple([string, number]) → string, number
	inner := typeExpr[len("tuple("):]
	if len(inner) > 0 && inner[len(inner)-1] == ')' {
		inner = inner[:len(inner)-1]
	}
	inner = strings.TrimSpace(inner)
	if len(inner) >= 2 && inner[0] == '[' && inner[len(inner)-1] == ']' {
		inner = inner[1 : len(inner)-1]
	}
	inner = strings.TrimSpace(inner)
	if inner == "" {
		return nil
	}

	schema := make(map[string]string)
	for i, elem := range strings.Split(inner, ",") {
		elem = strings.TrimSpace(elem)
		if elem == "" {
			continue
		}
		schema[fmt.Sprintf("%d", i)] = elem
	}

	if len(schema) == 0 {
		return nil
	}
	return schema
}

// extractObjectSchema parses an object({k=T, ...}) type expression into a schema map.
func extractObjectSchema(typeExpr string) map[string]string {
	typeExpr = strings.TrimSpace(typeExpr)
	if !strings.HasPrefix(typeExpr, "object(") {
		return nil
	}

	// Extract the inner content between object({ and })
	inner := typeExpr[len("object("):]
	if len(inner) > 0 && inner[len(inner)-1] == ')' {
		inner = inner[:len(inner)-1]
	}
	inner = strings.TrimSpace(inner)
	if len(inner) < 2 || inner[0] != '{' || inner[len(inner)-1] != '}' {
		return nil
	}
	inner = inner[1 : len(inner)-1]

	schema := make(map[string]string)
	// Simple field parsing — handles key = type patterns
	// This is intentionally simple; deeply nested types will show as their raw string
	for _, field := range splitObjectFields(inner) {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		parts := strings.SplitN(field, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		// Strip optional() wrapper for schema display
		if strings.HasPrefix(val, "optional(") && strings.HasSuffix(val, ")") {
			val = val[len("optional(") : len(val)-1]
		}
		schema[key] = val
	}

	if len(schema) == 0 {
		return nil
	}
	return schema
}

// splitObjectFields splits object fields by commas, respecting nested parentheses.
func splitObjectFields(s string) []string {
	var fields []string
	depth := 0
	start := 0
	for i, c := range s {
		switch c {
		case '(', '{', '[':
			depth++
		case ')', '}', ']':
			depth--
		case ',', '\n':
			if depth == 0 {
				fields = append(fields, s[start:i])
				start = i + 1
			}
		}
	}
	if start < len(s) {
		fields = append(fields, s[start:])
	}
	return fields
}

// processValidations converts TofuValidation blocks into boilerplate ValidationRules.
// Returns (validations, enum options if contains() was found, description suffix for enrichment).
func processValidations(v TofuVariable) ([]ValidationRule, []string, string) {
	var validations []ValidationRule
	var options []string
	var descSuffix string

	for _, tv := range v.Validations {
		cond := strings.TrimSpace(tv.Condition)

		// Tier 1: Actively mapped patterns

		// contains(["a","b","c"], var.x) → enum
		if enumOpts := extractContainsOptions(cond); enumOpts != nil {
			options = enumOpts
			continue
		}

		// can(regex("pattern", var.x)) → regex validation
		if pattern := extractRegexPattern(cond); pattern != "" {
			validations = append(validations, ValidationRule{
				Type:    ValidationRegex,
				Message: tv.ErrorMessage,
				Args:    []interface{}{pattern},
			})
			continue
		}

		// length(var.x) >= N && length(var.x) <= M → length validation
		if min, max, ok := extractLengthBounds(cond); ok {
			validations = append(validations, ValidationRule{
				Type:    ValidationLength,
				Message: tv.ErrorMessage,
				Args:    []interface{}{min, max},
			})
			continue
		}

		// var.x != "" or length(var.x) > 0 → required
		if isNonEmptyCheck(cond) {
			validations = append(validations, ValidationRule{
				Type:    ValidationRequired,
				Message: tv.ErrorMessage,
			})
			continue
		}

		// Numeric range: var.x >= N && var.x <= M → description enrichment
		if min, max, ok := extractNumericRange(cond); ok {
			suffix := fmt.Sprintf("(Must be between %s and %s)", min, max)
			descSuffix = appendSuffix(descSuffix, suffix)
			continue
		}

		// Tier 2: Description-enriched patterns
		if isTier2Pattern(cond) {
			if tv.ErrorMessage != "" {
				suffix := fmt.Sprintf("(Constraint: %s)", tv.ErrorMessage)
				descSuffix = appendSuffix(descSuffix, suffix)
			}
			continue
		}

		// Unrecognized: append error_message to description
		if tv.ErrorMessage != "" {
			suffix := fmt.Sprintf("(Constraint: %s)", tv.ErrorMessage)
			descSuffix = appendSuffix(descSuffix, suffix)
		}
	}

	return validations, options, descSuffix
}

// Regex patterns for validation condition matching
var (
	containsListRe = regexp.MustCompile(`contains\(\s*\[([^\]]+)\]\s*,\s*var\.`)
	regexPatternRe = regexp.MustCompile(`can\(\s*regex\(\s*"([^"]+)"`)
	lengthBoundsRe = regexp.MustCompile(`length\(var\.\w+\)\s*>=\s*(\d+)\s*&&\s*length\(var\.\w+\)\s*<=\s*(\d+)`)
	nonEmptyRe1    = regexp.MustCompile(`var\.\w+\s*!=\s*""`)
	nonEmptyRe2    = regexp.MustCompile(`length\(var\.\w+\)\s*>\s*0`)
	numericRangeRe = regexp.MustCompile(`var\.\w+\s*>=\s*([0-9.]+)\s*&&\s*var\.\w+\s*<=\s*([0-9.]+)`)
)

// extractContainsOptions extracts enum options from contains(["a","b","c"], var.x).
func extractContainsOptions(cond string) []string {
	match := containsListRe.FindStringSubmatch(cond)
	if match == nil {
		return nil
	}

	raw := match[1]
	var options []string
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		item = strings.Trim(item, `"'`)
		if item != "" {
			options = append(options, item)
		}
	}

	if len(options) == 0 {
		return nil
	}
	return options
}

// extractRegexPattern extracts the regex pattern from can(regex("pattern", var.x)).
func extractRegexPattern(cond string) string {
	match := regexPatternRe.FindStringSubmatch(cond)
	if match == nil {
		return ""
	}
	return match[1]
}

// extractLengthBounds extracts min/max from length(var.x) >= N && length(var.x) <= M.
func extractLengthBounds(cond string) (int, int, bool) {
	match := lengthBoundsRe.FindStringSubmatch(cond)
	if match == nil {
		return 0, 0, false
	}
	min, err1 := strconv.Atoi(match[1])
	max, err2 := strconv.Atoi(match[2])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return min, max, true
}

// isNonEmptyCheck returns true if the condition is a "non-empty" idiom.
func isNonEmptyCheck(cond string) bool {
	return nonEmptyRe1.MatchString(cond) || nonEmptyRe2.MatchString(cond)
}

// extractNumericRange extracts min/max from var.x >= N && var.x <= M.
func extractNumericRange(cond string) (string, string, bool) {
	match := numericRangeRe.FindStringSubmatch(cond)
	if match == nil {
		return "", "", false
	}
	return match[1], match[2], true
}

// singleBoundComparisonRe matches simple single-bound comparisons (e.g. var.x > 0).
var singleBoundComparisonRe = regexp.MustCompile(`var\.\w+\s*[<>]\s*[0-9.]+$`)

// isTier2Pattern checks if a condition matches a Tier 2 (description-enriched) pattern.
func isTier2Pattern(cond string) bool {
	tier2Patterns := []string{
		"can(tonumber(", "can(tostring(",
		"can(cidrhost(", "can(cidrsubnet(",
		"startswith(", "endswith(",
		"can(formatdate(",
		"alltrue(", "anytrue(",
	}
	for _, p := range tier2Patterns {
		if strings.Contains(cond, p) {
			return true
		}
	}
	return singleBoundComparisonRe.MatchString(strings.TrimSpace(cond))
}

func appendSuffix(existing, new string) string {
	if existing == "" {
		return new
	}
	return existing + " " + new
}

// buildSections groups variables into sections based on the priority order described in the plan.
func buildSections(vars []TofuVariable) []Section {
	// Priority 1: @group comments
	if sections := buildSectionsFromGroups(vars); len(sections) >= 2 {
		return sections
	}

	// Priority 2: Filename-based grouping
	if sections := buildSectionsFromFilenames(vars); len(sections) >= 2 {
		return sections
	}

	// Priority 3: Prefix-based grouping
	if sections := buildSectionsFromPrefixes(vars); len(sections) >= 2 {
		return sections
	}

	// Priority 4: Required vs Optional
	return buildSectionsRequiredOptional(vars)
}

// collectSections groups variables into sections using sectionFn to derive the
// section name for each variable. The unnamed section ("") is always placed first.
func collectSections(vars []TofuVariable, sectionFn func(TofuVariable) string) []Section {
	return groupIntoSections(vars, func(v TofuVariable) (string, string) {
		return v.Name, sectionFn(v)
	})
}

// buildSectionsFromGroups uses @group comments to build sections.
func buildSectionsFromGroups(vars []TofuVariable) []Section {
	return collectSections(vars, func(v TofuVariable) string {
		return v.GroupComment
	})
}

// buildSectionsFromFilenames groups variables by their source .tf filename.
func buildSectionsFromFilenames(vars []TofuVariable) []Section {
	sections := collectSections(vars, func(v TofuVariable) string {
		return filenameToSectionName(v.SourceFile)
	})
	// Sort named sections for determinism (unnamed "" stays first via collectSections)
	if len(sections) > 1 && sections[0].Name == "" {
		sort.Slice(sections[1:], func(i, j int) bool {
			return sections[1+i].Name < sections[1+j].Name
		})
	} else {
		sort.Slice(sections, func(i, j int) bool {
			return sections[i].Name < sections[j].Name
		})
	}
	return sections
}

// filenameToSectionName converts a .tf filename to a section name.
// "variables.tf" and "main.tf" become "" (default section).
// "network.tf" becomes "Network".
// "vpc_variables.tf" becomes "Vpc".
func filenameToSectionName(filename string) string {
	name := strings.TrimSuffix(filename, ".tf")

	// Default section for common filenames
	switch name {
	case "variables", "main", "vars":
		return ""
	}

	// Strip common suffixes
	for _, suffix := range []string{"_variables", "_vars"} {
		name = strings.TrimSuffix(name, suffix)
	}

	// Title-case with underscore/hyphen splitting
	parts := strings.FieldsFunc(name, func(r rune) bool {
		return r == '_' || r == '-'
	})
	for i, p := range parts {
		if len(p) > 0 {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

// buildSectionsFromPrefixes groups variables by common name prefixes.
func buildSectionsFromPrefixes(vars []TofuVariable) []Section {
	// Count prefix occurrences (using first segment before _)
	prefixCount := make(map[string]int)
	prefixVars := make(map[string][]string)

	for _, v := range vars {
		parts := strings.SplitN(v.Name, "_", 2)
		if len(parts) < 2 {
			continue
		}
		prefix := parts[0]
		prefixCount[prefix]++
		prefixVars[prefix] = append(prefixVars[prefix], v.Name)
	}

	// Only use prefixes with 2+ variables
	var validPrefixes []string
	for prefix, count := range prefixCount {
		if count >= 2 {
			validPrefixes = append(validPrefixes, prefix)
		}
	}

	if len(validPrefixes) < 2 {
		return nil
	}

	sort.Strings(validPrefixes)

	// Collect ungrouped variables
	grouped := make(map[string]bool)
	for _, prefix := range validPrefixes {
		for _, name := range prefixVars[prefix] {
			grouped[name] = true
		}
	}

	var sections []Section

	// Add ungrouped first as default section
	var ungrouped []string
	for _, v := range vars {
		if !grouped[v.Name] {
			ungrouped = append(ungrouped, v.Name)
		}
	}
	if len(ungrouped) > 0 {
		sections = append(sections, Section{Name: "", Variables: ungrouped})
	}

	// Add prefix sections
	for _, prefix := range validPrefixes {
		sections = append(sections, Section{
			Name:      strings.ToUpper(prefix),
			Variables: prefixVars[prefix],
		})
	}

	return sections
}

// buildSectionsRequiredOptional splits variables into "Required" and "Optional" sections.
func buildSectionsRequiredOptional(vars []TofuVariable) []Section {
	var required, optional []string
	for _, v := range vars {
		if !v.HasDefault && !v.Nullable {
			required = append(required, v.Name)
		} else {
			optional = append(optional, v.Name)
		}
	}

	var sections []Section
	if len(required) > 0 {
		sections = append(sections, Section{Name: "Required", Variables: required})
	}
	if len(optional) > 0 {
		sections = append(sections, Section{Name: "Optional", Variables: optional})
	}
	return sections
}
