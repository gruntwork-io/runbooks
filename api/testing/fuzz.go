package testing

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// FuzzGenerator generates random values for fuzz testing.
type FuzzGenerator struct{}

// NewFuzzGenerator creates a new fuzz value generator.
func NewFuzzGenerator() *FuzzGenerator {
	return &FuzzGenerator{}
}

// Generate generates a fuzz value based on the config.
func (g *FuzzGenerator) Generate(config *FuzzConfig) (interface{}, error) {
	if config == nil {
		return nil, fmt.Errorf("fuzz config is nil")
	}

	switch config.Type {
	case FuzzString:
		return g.generateString(config)
	case FuzzInt:
		return g.generateInt(config)
	case FuzzFloat:
		return g.generateFloat(config)
	case FuzzBool:
		return g.generateBool()
	case FuzzEnum:
		return g.generateEnum(config)
	case FuzzEmail:
		return g.generateEmail(config)
	case FuzzURL:
		return g.generateURL(config)
	case FuzzUUID:
		return g.generateUUID()
	case FuzzDate:
		return g.generateDate(config)
	case FuzzTimestamp:
		return g.generateTimestamp(config)
	case FuzzWords:
		return g.generateWords(config)
	case FuzzList:
		return g.generateList(config)
	case FuzzMap:
		return g.generateMap(config)
	default:
		return nil, fmt.Errorf("unknown fuzz type: %s", config.Type)
	}
}

// generateString generates a random string respecting constraints.
func (g *FuzzGenerator) generateString(config *FuzzConfig) (string, error) {
	// Determine length
	length := config.Length
	if length <= 0 {
		// Use min/max if provided
		minLen := config.MinLength
		maxLen := config.MaxLength

		if minLen <= 0 {
			minLen = 8
		}
		if maxLen <= 0 {
			maxLen = minLen + 10
		}
		if maxLen < minLen {
			maxLen = minLen
		}

		// Random length between min and max
		rangeSize := maxLen - minLen + 1
		n, err := rand.Int(rand.Reader, big.NewInt(int64(rangeSize)))
		if err != nil {
			return "", fmt.Errorf("failed to generate random length: %w", err)
		}
		length = minLen + int(n.Int64())
	}

	// Build charset based on options
	charset := "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	if config.IncludeSpaces {
		charset += " "
	}
	if config.IncludeSpecialChars {
		charset += "!@#$%^&*()-_=+[]{}|;:,.<>?"
	}

	// Generate random string
	result := make([]byte, length)
	for i := range result {
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		if err != nil {
			return "", fmt.Errorf("failed to generate random character: %w", err)
		}
		result[i] = charset[idx.Int64()]
	}

	// Apply prefix and suffix
	finalResult := config.Prefix + string(result) + config.Suffix
	return finalResult, nil
}

// generateInt generates a random integer in the given range.
func (g *FuzzGenerator) generateInt(config *FuzzConfig) (int, error) {
	min := config.Min
	max := config.Max

	if max <= min {
		min, max = 0, 100 // Default range
	}

	rangeSize := big.NewInt(int64(max - min + 1))
	n, err := rand.Int(rand.Reader, rangeSize)
	if err != nil {
		return 0, fmt.Errorf("failed to generate random number: %w", err)
	}

	return int(n.Int64()) + min, nil
}

// generateFloat generates a random float in the given range.
func (g *FuzzGenerator) generateFloat(config *FuzzConfig) (float64, error) {
	min := float64(config.Min)
	max := float64(config.Max)

	if max <= min {
		min, max = 0.0, 100.0 // Default range
	}

	// Generate random value between 0 and 1
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return 0, fmt.Errorf("failed to generate random number: %w", err)
	}

	ratio := float64(n.Int64()) / 1000000.0
	return min + (max-min)*ratio, nil
}

// generateBool generates a random boolean.
func (g *FuzzGenerator) generateBool() (bool, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(2))
	if err != nil {
		return false, fmt.Errorf("failed to generate random number: %w", err)
	}
	return n.Int64() == 1, nil
}

// generateEnum generates a random value from the enum options.
func (g *FuzzGenerator) generateEnum(config *FuzzConfig) (string, error) {
	if len(config.Options) == 0 {
		return "", fmt.Errorf("no enum options provided")
	}

	idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(config.Options))))
	if err != nil {
		return "", fmt.Errorf("failed to generate random number: %w", err)
	}

	return config.Options[idx.Int64()], nil
}

// generateEmail generates a random email address.
func (g *FuzzGenerator) generateEmail(config *FuzzConfig) (string, error) {
	// Generate local part
	localConfig := &FuzzConfig{Type: FuzzString, MinLength: 6, MaxLength: 10}
	localPart, err := g.generateString(localConfig)
	if err != nil {
		return "", err
	}

	domain := config.Domain
	if domain == "" {
		domains := []string{"example.com", "test.org", "demo.net", "sample.io"}
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(domains))))
		if err != nil {
			return "", fmt.Errorf("failed to generate random number: %w", err)
		}
		domain = domains[idx.Int64()]
	}

	return fmt.Sprintf("%s@%s", strings.ToLower(localPart), domain), nil
}

// generateURL generates a random URL.
func (g *FuzzGenerator) generateURL(config *FuzzConfig) (string, error) {
	// Generate path
	pathConfig := &FuzzConfig{Type: FuzzString, MinLength: 4, MaxLength: 8}
	path, err := g.generateString(pathConfig)
	if err != nil {
		return "", err
	}

	domain := config.Domain
	if domain == "" {
		domains := []string{"example.com", "test.org", "demo.net", "sample.io"}
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(domains))))
		if err != nil {
			return "", fmt.Errorf("failed to generate random number: %w", err)
		}
		domain = domains[idx.Int64()]
	}

	return fmt.Sprintf("https://%s/%s", domain, strings.ToLower(path)), nil
}

// generateUUID generates a random UUID v4.
func (g *FuzzGenerator) generateUUID() (string, error) {
	uuid := make([]byte, 16)
	_, err := rand.Read(uuid)
	if err != nil {
		return "", fmt.Errorf("failed to generate random bytes: %w", err)
	}

	// Set version 4 and variant bits
	uuid[6] = (uuid[6] & 0x0f) | 0x40
	uuid[8] = (uuid[8] & 0x3f) | 0x80

	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		uuid[0:4], uuid[4:6], uuid[6:8], uuid[8:10], uuid[10:16]), nil
}

// parseDateString attempts to parse a date string using common formats.
// It tries RFC3339, ISO8601 date-only, and common date formats.
func parseDateString(dateStr string) (time.Time, error) {
	formats := []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05",
		"2006-01-02",
		"01/02/2006",
		"02-01-2006",
	}

	for _, format := range formats {
		if t, err := time.Parse(format, dateStr); err == nil {
			return t, nil
		}
	}

	return time.Time{}, fmt.Errorf("unable to parse date string %q: tried formats RFC3339, ISO8601, YYYY-MM-DD, MM/DD/YYYY, DD-MM-YYYY", dateStr)
}

// generateRandomTimeInRange generates a random time within the specified range.
// If minDate/maxDate are empty strings, defaults to the range [365 days ago, now].
// The precision parameter controls the granularity: time.Second for timestamps, 24*time.Hour for dates.
func generateRandomTimeInRange(minDate, maxDate string, precision time.Duration) (time.Time, error) {
	var minTime, maxTime time.Time
	now := time.Now()

	// Parse MinDate if provided
	if minDate != "" {
		parsed, err := parseDateString(minDate)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid minDate %q: %w", minDate, err)
		}
		minTime = parsed
	} else {
		// Default: 365 days ago
		minTime = now.AddDate(0, 0, -365)
	}

	// Parse MaxDate if provided
	if maxDate != "" {
		parsed, err := parseDateString(maxDate)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid maxDate %q: %w", maxDate, err)
		}
		maxTime = parsed
	} else {
		// Default: now
		maxTime = now
	}

	// Validate that min <= max
	if minTime.After(maxTime) {
		return time.Time{}, fmt.Errorf("minDate (%s) is after maxDate (%s)", minDate, maxDate)
	}

	// Calculate the range in units of precision
	rangeDiff := int64(maxTime.Sub(minTime) / precision)
	if rangeDiff < 0 {
		rangeDiff = 0
	}

	// Generate a random offset
	var offset int64
	if rangeDiff > 0 {
		n, err := rand.Int(rand.Reader, big.NewInt(rangeDiff+1))
		if err != nil {
			return time.Time{}, fmt.Errorf("failed to generate random number: %w", err)
		}
		offset = n.Int64()
	}

	return minTime.Add(time.Duration(offset) * precision), nil
}

// generateDate generates a random date string (YYYY-MM-DD).
// If MinDate and/or MaxDate are provided, the generated date will be within that range.
func (g *FuzzGenerator) generateDate(config *FuzzConfig) (string, error) {
	format := config.Format
	if format == "" {
		format = "2006-01-02"
	}

	date, err := generateRandomTimeInRange(config.MinDate, config.MaxDate, 24*time.Hour)
	if err != nil {
		return "", err
	}

	return date.Format(format), nil
}

// generateTimestamp generates a random timestamp (RFC3339).
// If MinDate and/or MaxDate are provided, the generated timestamp will be within that range.
func (g *FuzzGenerator) generateTimestamp(config *FuzzConfig) (string, error) {
	format := config.Format
	if format == "" {
		format = time.RFC3339
	}

	ts, err := generateRandomTimeInRange(config.MinDate, config.MaxDate, time.Second)
	if err != nil {
		return "", err
	}

	return ts.Format(format), nil
}

// generateWords generates random words.
func (g *FuzzGenerator) generateWords(config *FuzzConfig) (string, error) {
	count := config.WordCount
	if count <= 0 {
		minCount := config.MinWordCount
		maxCount := config.MaxWordCount

		if minCount <= 0 {
			minCount = 2
		}
		if maxCount <= 0 {
			maxCount = minCount + 3
		}

		rangeSize := maxCount - minCount + 1
		n, err := rand.Int(rand.Reader, big.NewInt(int64(rangeSize)))
		if err != nil {
			return "", fmt.Errorf("failed to generate random count: %w", err)
		}
		count = minCount + int(n.Int64())
	}

	words := []string{
		"alpha", "bravo", "charlie", "delta", "echo",
		"foxtrot", "golf", "hotel", "india", "juliet",
		"kilo", "lima", "mike", "november", "oscar",
		"papa", "quebec", "romeo", "sierra", "tango",
		"uniform", "victor", "whiskey", "xray", "yankee", "zulu",
	}

	result := make([]string, count)
	for i := range result {
		idx, err := rand.Int(rand.Reader, big.NewInt(int64(len(words))))
		if err != nil {
			return "", fmt.Errorf("failed to generate random number: %w", err)
		}
		result[i] = words[idx.Int64()]
	}

	return strings.Join(result, " "), nil
}

// generateList generates a list of random strings in JSON format.
// Boilerplate expects lists in JSON format: ["value1", "value2", "value3"]
func (g *FuzzGenerator) generateList(config *FuzzConfig) (string, error) {
	// Determine count
	count := config.Count
	if count <= 0 {
		minCount := config.MinCount
		maxCount := config.MaxCount

		if minCount <= 0 {
			minCount = 2
		}
		if maxCount <= 0 {
			maxCount = minCount + 3
		}
		if maxCount < minCount {
			maxCount = minCount
		}

		rangeSize := maxCount - minCount + 1
		n, err := rand.Int(rand.Reader, big.NewInt(int64(rangeSize)))
		if err != nil {
			return "", fmt.Errorf("failed to generate random count: %w", err)
		}
		count = minCount + int(n.Int64())
	}

	// Generate list items using string generation
	items := make([]string, count)
	itemConfig := &FuzzConfig{
		Type:      FuzzString,
		MinLength: config.MinLength,
		MaxLength: config.MaxLength,
	}
	// Use reasonable defaults if not specified
	if itemConfig.MinLength <= 0 {
		itemConfig.MinLength = 5
	}
	if itemConfig.MaxLength <= 0 {
		itemConfig.MaxLength = 12
	}

	for i := 0; i < count; i++ {
		item, err := g.generateString(itemConfig)
		if err != nil {
			return "", fmt.Errorf("failed to generate list item: %w", err)
		}
		items[i] = item
	}

	// Return as JSON array string (boilerplate expects this format)
	jsonBytes, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("failed to marshal list to JSON: %w", err)
	}

	return string(jsonBytes), nil
}

// generateMap generates a map of random string keys to values.
// If schema is provided, generates a map[string]map[string]string (nested map) as a Go map.
// Otherwise, returns a JSON string for flat maps: {"key1": "value1", "key2": "value2"}
func (g *FuzzGenerator) generateMap(config *FuzzConfig) (interface{}, error) {
	// Determine count of key-value pairs
	count := config.Count
	if count <= 0 {
		minCount := config.MinCount
		maxCount := config.MaxCount

		if minCount <= 0 {
			minCount = 2
		}
		if maxCount <= 0 {
			maxCount = minCount + 2
		}
		if maxCount < minCount {
			maxCount = minCount
		}

		rangeSize := maxCount - minCount + 1
		n, err := rand.Int(rand.Reader, big.NewInt(int64(rangeSize)))
		if err != nil {
			return "", fmt.Errorf("failed to generate random count: %w", err)
		}
		count = minCount + int(n.Int64())
	}

	keyConfig := &FuzzConfig{
		Type:      FuzzString,
		MinLength: 5,
		MaxLength: 12,
	}

	// If schema is provided, generate nested maps (for x-schema maps)
	if len(config.Schema) > 0 {
		result := make(map[string]interface{})
		valueConfig := &FuzzConfig{
			Type:      FuzzString,
			MinLength: 5,
			MaxLength: 15,
		}

		for i := 0; i < count; i++ {
			key, err := g.generateString(keyConfig)
			if err != nil {
				return nil, fmt.Errorf("failed to generate map key: %w", err)
			}

			// Generate nested map with schema fields
			nested := make(map[string]interface{})
			for _, field := range config.Schema {
				fieldValue, err := g.generateString(valueConfig)
				if err != nil {
					return nil, fmt.Errorf("failed to generate nested field %s: %w", field, err)
				}
				nested[field] = fieldValue
			}
			result[key] = nested
		}

		// Return as Go map (not JSON string) for proper boilerplate handling
		return result, nil
	}

	// No schema - generate flat map as JSON string
	result := make(map[string]string)
	valueConfig := &FuzzConfig{
		Type:      FuzzString,
		MinLength: config.MinLength,
		MaxLength: config.MaxLength,
	}
	if valueConfig.MinLength <= 0 {
		valueConfig.MinLength = 5
	}
	if valueConfig.MaxLength <= 0 {
		valueConfig.MaxLength = 12
	}

	for i := 0; i < count; i++ {
		key, err := g.generateString(keyConfig)
		if err != nil {
			return "", fmt.Errorf("failed to generate map key: %w", err)
		}
		value, err := g.generateString(valueConfig)
		if err != nil {
			return "", fmt.Errorf("failed to generate map value: %w", err)
		}
		result[key] = value
	}

	// Return as JSON object string (boilerplate expects this format for flat maps)
	jsonBytes, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("failed to marshal map to JSON: %w", err)
	}

	return string(jsonBytes), nil
}

// ResolveTestConfig resolves all test inputs, generating fuzz values where needed.
// This generates concrete values from fuzz specs and literal values in the test YAML.
func ResolveTestConfig(inputs map[string]InputValue) (map[string]interface{}, error) {
	result := make(map[string]interface{})
	generator := NewFuzzGenerator()

	for name, value := range inputs {
		if value.IsLiteral() {
			result[name] = value.Literal
		} else {
			fuzzValue, err := generator.Generate(value.Fuzz)
			if err != nil {
				return nil, fmt.Errorf("failed to generate fuzz value for %q: %w", name, err)
			}
			result[name] = fuzzValue
		}
	}

	return result, nil
}
