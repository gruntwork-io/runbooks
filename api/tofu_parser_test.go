package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIsTofuModule(t *testing.T) {
	tests := []struct {
		name     string
		files    map[string]string
		expected bool
	}{
		{
			name:     "directory with .tf files",
			files:    map[string]string{"main.tf": "variable \"x\" {}"},
			expected: true,
		},
		{
			name:     "directory with runbook.mdx",
			files:    map[string]string{"main.tf": "", "runbook.mdx": "# Hello"},
			expected: false,
		},
		{
			name:     "directory with runbook.md",
			files:    map[string]string{"main.tf": "", "runbook.md": "# Hello"},
			expected: false,
		},
		{
			name:     "empty directory",
			files:    map[string]string{},
			expected: false,
		},
		{
			name:     "directory without .tf files",
			files:    map[string]string{"readme.md": "# Hello"},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, content := range tt.files {
				err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644)
				require.NoError(t, err)
			}
			assert.Equal(t, tt.expected, IsTofuModule(dir))
		})
	}

	t.Run("nonexistent path", func(t *testing.T) {
		assert.False(t, IsTofuModule("/nonexistent/path"))
	})

	t.Run("file path not directory", func(t *testing.T) {
		f := filepath.Join(t.TempDir(), "main.tf")
		err := os.WriteFile(f, []byte(""), 0644)
		require.NoError(t, err)
		assert.False(t, IsTofuModule(f))
	})
}

func TestParseTofuModule_S3Bucket(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/s3-bucket"
	vars, err := ParseTofuModule(fixtureDir)
	require.NoError(t, err)
	require.NotEmpty(t, vars)

	// Find specific variables
	varMap := make(map[string]TofuVariable)
	for _, v := range vars {
		varMap[v.Name] = v
	}

	// bucket_name: required string with regex validation
	bucketName, ok := varMap["bucket_name"]
	require.True(t, ok, "bucket_name variable not found")
	assert.Equal(t, "string", bucketName.Type)
	assert.Equal(t, "Name of the S3 bucket", bucketName.Description)
	assert.False(t, bucketName.HasDefault)
	require.Len(t, bucketName.Validations, 1)
	assert.Contains(t, bucketName.Validations[0].Condition, "regex")
	assert.Equal(t, "Must be lowercase alphanumeric with dots and hyphens.", bucketName.Validations[0].ErrorMessage)

	// versioning_enabled: bool with default
	versioning, ok := varMap["versioning_enabled"]
	require.True(t, ok, "versioning_enabled variable not found")
	assert.Equal(t, "bool", versioning.Type)
	assert.True(t, versioning.HasDefault)
	assert.Equal(t, true, versioning.Default)

	// tags: map(string) with default
	tags, ok := varMap["tags"]
	require.True(t, ok, "tags variable not found")
	assert.Contains(t, tags.Type, "map(string)")
	assert.True(t, tags.HasDefault)

	// expiration_days: has @group "Lifecycle"
	expiration, ok := varMap["expiration_days"]
	require.True(t, ok, "expiration_days variable not found")
	assert.Equal(t, "Lifecycle", expiration.GroupComment)

	// transition_to_glacier_days: has @group "Lifecycle"
	glacier, ok := varMap["transition_to_glacier_days"]
	require.True(t, ok, "transition_to_glacier_days variable not found")
	assert.Equal(t, "Lifecycle", glacier.GroupComment)
}

func TestParseTofuModule_LambdaFunction(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-function"
	vars, err := ParseTofuModule(fixtureDir)
	require.NoError(t, err)

	varMap := make(map[string]TofuVariable)
	for _, v := range vars {
		varMap[v.Name] = v
	}

	// function_name: required string (no default)
	fn, ok := varMap["function_name"]
	require.True(t, ok)
	assert.Equal(t, "string", fn.Type)
	assert.False(t, fn.HasDefault)

	// runtime: contains() validation
	runtime, ok := varMap["runtime"]
	require.True(t, ok)
	require.Len(t, runtime.Validations, 1)
	assert.Contains(t, runtime.Validations[0].Condition, "contains")

	// memory_size from settings.tf: has @group "Advanced Settings"
	memSize, ok := varMap["memory_size"]
	require.True(t, ok)
	assert.Equal(t, "Advanced Settings", memSize.GroupComment)
	assert.Equal(t, "settings.tf", memSize.SourceFile)

	// reserved_concurrency: nullable
	reserved, ok := varMap["reserved_concurrency"]
	require.True(t, ok)
	assert.True(t, reserved.Nullable)
}

func TestParseTofuModule_Complex(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-s3-complex"
	vars, err := ParseTofuModule(fixtureDir)
	require.NoError(t, err)

	varMap := make(map[string]TofuVariable)
	for _, v := range vars {
		varMap[v.Name] = v
	}

	// environment: contains() validation
	env, ok := varMap["environment"]
	require.True(t, ok)
	require.Len(t, env.Validations, 1)
	assert.Contains(t, env.Validations[0].Condition, "contains")

	// subnet_ids: list(string)
	subnets, ok := varMap["subnet_ids"]
	require.True(t, ok)
	assert.Contains(t, subnets.Type, "list(string)")

	// security_group_ids: set(string)
	sgids, ok := varMap["security_group_ids"]
	require.True(t, ok)
	assert.Contains(t, sgids.Type, "set(string)")

	// notification_config: object type
	notif, ok := varMap["notification_config"]
	require.True(t, ok)
	assert.Contains(t, notif.Type, "object(")

	// priority_order: tuple
	priority, ok := varMap["priority_order"]
	require.True(t, ok)
	assert.Contains(t, priority.Type, "tuple(")

	// enable_monitoring: sensitive
	monitoring, ok := varMap["enable_monitoring"]
	require.True(t, ok)
	assert.True(t, monitoring.Sensitive)
}

func TestMapToBoilerplateConfig_S3Bucket(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/s3-bucket"
	vars, err := ParseTofuModule(fixtureDir)
	require.NoError(t, err)

	config := MapToBoilerplateConfig(vars)
	require.NotNil(t, config)

	varMap := make(map[string]BoilerplateVariable)
	for _, v := range config.Variables {
		varMap[v.Name] = v
	}

	// bucket_name: should have required + regex validations
	bucketName := varMap["bucket_name"]
	assert.Equal(t, VarTypeString, bucketName.Type)
	assert.True(t, bucketName.Required)
	require.True(t, len(bucketName.Validations) >= 2) // required + regex
	hasRequired := false
	hasRegex := false
	for _, v := range bucketName.Validations {
		if v.Type == ValidationRequired {
			hasRequired = true
		}
		if v.Type == ValidationRegex {
			hasRegex = true
			require.Len(t, v.Args, 1)
			assert.Equal(t, "^[a-z0-9][a-z0-9.-]*[a-z0-9]$", v.Args[0])
		}
	}
	assert.True(t, hasRequired, "bucket_name should have required validation")
	assert.True(t, hasRegex, "bucket_name should have regex validation")

	// versioning_enabled: bool with default
	versioning := varMap["versioning_enabled"]
	assert.Equal(t, VarTypeBool, versioning.Type)
	assert.False(t, versioning.Required)

	// tags: map type
	tags := varMap["tags"]
	assert.Equal(t, VarTypeMap, tags.Type)

	// expiration_days: should have section "Lifecycle"
	expiration := varMap["expiration_days"]
	assert.Equal(t, "Lifecycle", expiration.SectionName)

	// Sections should include "Lifecycle"
	require.NotEmpty(t, config.Sections)
	hasLifecycle := false
	for _, s := range config.Sections {
		if s.Name == "Lifecycle" {
			hasLifecycle = true
			assert.Contains(t, s.Variables, "expiration_days")
			assert.Contains(t, s.Variables, "transition_to_glacier_days")
		}
	}
	assert.True(t, hasLifecycle, "should have a Lifecycle section")
}

func TestMapToBoilerplateConfig_ContainsToEnum(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-function"
	vars, err := ParseTofuModule(fixtureDir)
	require.NoError(t, err)

	config := MapToBoilerplateConfig(vars)

	varMap := make(map[string]BoilerplateVariable)
	for _, v := range config.Variables {
		varMap[v.Name] = v
	}

	// runtime with contains() should become enum
	runtime := varMap["runtime"]
	assert.Equal(t, VarTypeEnum, runtime.Type)
	assert.Equal(t, []string{"python3.13", "python3.12", "nodejs22.x", "nodejs20.x"}, runtime.Options)
}

func TestMapToBoilerplateConfig_ObjectSchema(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-s3-complex"
	vars, err := ParseTofuModule(fixtureDir)
	require.NoError(t, err)

	config := MapToBoilerplateConfig(vars)

	varMap := make(map[string]BoilerplateVariable)
	for _, v := range config.Variables {
		varMap[v.Name] = v
	}

	// notification_config: object → map with x-schema
	notif := varMap["notification_config"]
	assert.Equal(t, VarTypeMap, notif.Type)
	require.NotNil(t, notif.Schema)
	assert.Equal(t, "string", notif.Schema["email"])
	assert.Equal(t, "string", notif.Schema["slack_webhook"])
}

func TestMapToBoilerplateConfig_TupleNote(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-s3-complex"
	vars, err := ParseTofuModule(fixtureDir)
	require.NoError(t, err)

	config := MapToBoilerplateConfig(vars)

	varMap := make(map[string]BoilerplateVariable)
	for _, v := range config.Variables {
		varMap[v.Name] = v
	}

	// priority_order: tuple → list with schema for element types
	priority := varMap["priority_order"]
	assert.Equal(t, VarTypeList, priority.Type)
	require.NotNil(t, priority.Schema)
	assert.Equal(t, "string", priority.Schema["0"])
	assert.Equal(t, "number", priority.Schema["1"])
}

func TestMapTofuType(t *testing.T) {
	tests := []struct {
		input    string
		expected BoilerplateVarType
	}{
		{"string", VarTypeString},
		{"number", VarTypeInt},
		{"bool", VarTypeBool},
		{"list(string)", VarTypeList},
		{"set(string)", VarTypeList},
		{"map(string)", VarTypeMap},
		{"object({key = string})", VarTypeMap},
		{"tuple([string, number])", VarTypeList},
		{"any", VarTypeString},
		{"", VarTypeString},
		{"optional(string)", VarTypeString},
		{"optional(number)", VarTypeInt},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.expected, MapTofuType(tt.input))
		})
	}
}

func TestExtractRegexPattern(t *testing.T) {
	tests := []struct {
		condition string
		expected  string
	}{
		{`can(regex("^[a-z]+$", var.name))`, `^[a-z]+$`},
		{`can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.bucket_name))`, `^[a-z0-9][a-z0-9.-]*[a-z0-9]$`},
		{`length(var.name) > 0`, ``},
	}

	for _, tt := range tests {
		t.Run(tt.condition, func(t *testing.T) {
			assert.Equal(t, tt.expected, extractRegexPattern(tt.condition))
		})
	}
}

func TestExtractContainsOptions(t *testing.T) {
	tests := []struct {
		condition string
		expected  []string
	}{
		{
			`contains(["dev", "staging", "prod"], var.env)`,
			[]string{"dev", "staging", "prod"},
		},
		{
			`contains(["python3.13","nodejs22.x"], var.runtime)`,
			[]string{"python3.13", "nodejs22.x"},
		},
		{
			`length(var.name) > 0`,
			nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.condition, func(t *testing.T) {
			result := extractContainsOptions(tt.condition)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestBuildSectionsFromGroups(t *testing.T) {
	vars := []TofuVariable{
		{Name: "a", GroupComment: ""},
		{Name: "b", GroupComment: "Network"},
		{Name: "c", GroupComment: "Network"},
		{Name: "d", GroupComment: "Storage"},
	}

	sections := buildSectionsFromGroups(vars)
	require.Len(t, sections, 3)
	assert.Equal(t, "", sections[0].Name)
	assert.Equal(t, []string{"a"}, sections[0].Variables)
	assert.Equal(t, "Network", sections[1].Name)
	assert.Equal(t, []string{"b", "c"}, sections[1].Variables)
	assert.Equal(t, "Storage", sections[2].Name)
	assert.Equal(t, []string{"d"}, sections[2].Variables)
}

func TestBuildSectionsFromFilenames(t *testing.T) {
	vars := []TofuVariable{
		{Name: "a", SourceFile: "variables.tf"},
		{Name: "b", SourceFile: "network.tf"},
		{Name: "c", SourceFile: "network.tf"},
	}

	sections := buildSectionsFromFilenames(vars)
	require.Len(t, sections, 2)
	// "" (from variables.tf) should be first
	assert.Equal(t, "", sections[0].Name)
	assert.Equal(t, "Network", sections[1].Name)
}

func TestBuildSectionsFromPrefixes(t *testing.T) {
	vars := []TofuVariable{
		{Name: "vpc_id"},
		{Name: "vpc_cidr"},
		{Name: "subnet_id"},
		{Name: "subnet_cidr"},
		{Name: "name"},
	}

	sections := buildSectionsFromPrefixes(vars)
	require.NotEmpty(t, sections)

	// Should have ungrouped + SUBNET + VPC sections
	sectionNames := make(map[string]bool)
	for _, s := range sections {
		sectionNames[s.Name] = true
	}
	assert.True(t, sectionNames["SUBNET"])
	assert.True(t, sectionNames["VPC"])
}

func TestFilenameToSectionName(t *testing.T) {
	tests := []struct {
		filename string
		expected string
	}{
		{"variables.tf", ""},
		{"main.tf", ""},
		{"vars.tf", ""},
		{"network.tf", "Network"},
		{"vpc_variables.tf", "Vpc"},
		{"api_gateway.tf", "Api Gateway"},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			assert.Equal(t, tt.expected, filenameToSectionName(tt.filename))
		})
	}
}

func TestExtractTupleSchema(t *testing.T) {
	t.Run("string and number", func(t *testing.T) {
		schema := extractTupleSchema("tuple([string, number])")
		require.NotNil(t, schema)
		assert.Equal(t, "string", schema["0"])
		assert.Equal(t, "number", schema["1"])
		assert.Len(t, schema, 2)
	})

	t.Run("single element", func(t *testing.T) {
		schema := extractTupleSchema("tuple([bool])")
		require.NotNil(t, schema)
		assert.Equal(t, "bool", schema["0"])
		assert.Len(t, schema, 1)
	})

	t.Run("three elements", func(t *testing.T) {
		schema := extractTupleSchema("tuple([bool, string, number])")
		require.NotNil(t, schema)
		assert.Len(t, schema, 3)
		assert.Equal(t, "bool", schema["0"])
		assert.Equal(t, "string", schema["1"])
		assert.Equal(t, "number", schema["2"])
	})

	t.Run("empty tuple", func(t *testing.T) {
		assert.Nil(t, extractTupleSchema("tuple([])"))
	})

	t.Run("not a tuple", func(t *testing.T) {
		assert.Nil(t, extractTupleSchema("list(string)"))
	})
}

func TestParseTofuModuleMetadata(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/s3-bucket"

	meta := ParseTofuModuleMetadata(fixtureDir)

	assert.Equal(t, "s3-bucket", meta.FolderName)
	assert.Equal(t, "S3 Bucket Module", meta.ReadmeTitle)
	assert.Equal(t, []string{"bucket_arn", "bucket_name"}, meta.OutputNames)
	assert.Equal(t, []string{"aws_s3_bucket.this", "aws_s3_bucket_versioning.this"}, meta.ResourceNames)
}

func TestParseTofuModuleMetadata_NoReadme(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-function"

	meta := ParseTofuModuleMetadata(fixtureDir)

	assert.Equal(t, "lambda-function", meta.FolderName)
	assert.Empty(t, meta.ReadmeTitle)
}

func TestParseTofuModuleMetadata_NoOutputsOrResources(t *testing.T) {
	fixtureDir := "../testdata/test-fixtures/tofu-modules/lambda-function"

	meta := ParseTofuModuleMetadata(fixtureDir)

	assert.Nil(t, meta.OutputNames)
	assert.Nil(t, meta.ResourceNames)
}

func TestSlugify(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"lambda-function", "lambda-function"},
		{"my_module", "my-module"},
		{"My Module!", "my-module"},
		{"test--module", "test-module"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.expected, slugify(tt.input))
		})
	}
}
