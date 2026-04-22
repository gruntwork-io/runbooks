package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// tfParseRequest is a test helper that fires a POST /api/tf/parse with the given body.
func tfParseRequest(t *testing.T, gruntbookPath string, body interface{}) (int, []byte) {
	t.Helper()
	// These tests exercise only local-path resolution, so a nil resolver is
	// safe: resolveModuleSource only touches tokens on the remote-URL branch.
	return postJSON(t, "/api/tf/parse", HandleTfModuleParse(gruntbookPath, nil), body)
}

func TestHandleTfModuleParse_LocalPath(t *testing.T) {
	// Use the real s3-bucket fixture
	fixtureDir, err := filepath.Abs("../testdata/test-fixtures/tf-modules/s3-bucket")
	require.NoError(t, err)

	// The gruntbook path is used for relative path resolution — use the fixture parent
	gruntbookPath := filepath.Join(fixtureDir, "gruntbook.mdx")

	code, body := tfParseRequest(t, gruntbookPath, TfParseRequest{
		Source: fixtureDir,
	})

	assert.Equal(t, http.StatusOK, code)

	var resp TfParseResponse
	require.NoError(t, json.Unmarshal(body, &resp))

	// Should have parsed variables from the fixture
	assert.Greater(t, len(resp.Variables), 0, "should have parsed variables")

	// Should have metadata
	assert.Equal(t, "s3-bucket", resp.Metadata.FolderName)
}

func TestHandleTfModuleParse_RelativePath(t *testing.T) {
	// Test that relative paths resolve correctly against gruntbook directory
	fixtureDir, err := filepath.Abs("../testdata/test-fixtures/tf-modules")
	require.NoError(t, err)

	// Place the "gruntbook" in the tf-modules parent directory
	gruntbookPath := filepath.Join(fixtureDir, "gruntbook.mdx")

	code, body := tfParseRequest(t, gruntbookPath, TfParseRequest{
		Source: "s3-bucket",
	})

	assert.Equal(t, http.StatusOK, code)

	var resp TfParseResponse
	require.NoError(t, json.Unmarshal(body, &resp))
	assert.Greater(t, len(resp.Variables), 0, "should have parsed variables from relative path")
	assert.Equal(t, "s3-bucket", resp.Metadata.FolderName)
}

func TestHandleTfModuleParse_DotPath(t *testing.T) {
	// Test source="." (colocated module) — resolves to the gruntbook's own directory
	fixtureDir, err := filepath.Abs("../testdata/test-fixtures/tf-modules/s3-bucket")
	require.NoError(t, err)

	gruntbookPath := filepath.Join(fixtureDir, "gruntbook.mdx")

	code, body := tfParseRequest(t, gruntbookPath, TfParseRequest{
		Source: ".",
	})

	assert.Equal(t, http.StatusOK, code)

	var resp TfParseResponse
	require.NoError(t, json.Unmarshal(body, &resp))
	assert.Greater(t, len(resp.Variables), 0, "should have parsed variables from '.' path")
}

func TestHandleTfModuleParse_InvalidJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/tf/parse", HandleTfModuleParse("/fake/gruntbook.mdx", nil))

	req, err := http.NewRequest("POST", "/api/tf/parse", bytes.NewBufferString("not json"))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)

	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "Invalid request body", resp["error"])
}

func TestHandleTfModuleParse_MissingSource(t *testing.T) {
	// Empty source should fail validation (binding:"required")
	code, _ := tfParseRequest(t, "/fake/gruntbook.mdx", map[string]string{})
	assert.Equal(t, http.StatusBadRequest, code)
}

func TestHandleTfModuleParse_NonExistentPath(t *testing.T) {
	gruntbookPath := filepath.Join(t.TempDir(), "gruntbook.mdx")

	code, body := tfParseRequest(t, gruntbookPath, TfParseRequest{
		Source: "/nonexistent/path/to/module",
	})

	assert.Equal(t, http.StatusNotFound, code)

	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(body, &resp))
	assert.Equal(t, "Module directory not found", resp["error"])
}

func TestHandleTfModuleParse_FileNotDirectory(t *testing.T) {
	// Create a regular file (not a directory) and try to parse it
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "not-a-directory.tf")
	require.NoError(t, os.WriteFile(filePath, []byte("variable \"x\" {}"), 0644))

	gruntbookPath := filepath.Join(tmpDir, "gruntbook.mdx")

	code, body := tfParseRequest(t, gruntbookPath, TfParseRequest{
		Source: filePath,
	})

	assert.Equal(t, http.StatusBadRequest, code)

	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(body, &resp))
	assert.Equal(t, "Path is not a directory", resp["error"])
}

func TestHandleTfModuleParse_ComplexModule(t *testing.T) {
	// Use the complex fixture to verify full pipeline with many variables
	fixtureDir, err := filepath.Abs("../testdata/test-fixtures/tf-modules/lambda-s3-complex")
	require.NoError(t, err)

	gruntbookPath := filepath.Join(fixtureDir, "gruntbook.mdx")

	code, body := tfParseRequest(t, gruntbookPath, TfParseRequest{
		Source: fixtureDir,
	})

	assert.Equal(t, http.StatusOK, code)

	var resp TfParseResponse
	require.NoError(t, json.Unmarshal(body, &resp))

	// Complex module should have many variables (spread across multiple .tf files)
	assert.Greater(t, len(resp.Variables), 5, "complex module should have many variables")
	assert.Equal(t, "lambda-s3-complex", resp.Metadata.FolderName)
	assert.Equal(t, "Lambda S3 Event Processor", resp.Metadata.ReadmeTitle)

	// Should have outputs from outputs.tf
	assert.Equal(t, 5, len(resp.Metadata.OutputNames), "should have 5 outputs")
	assert.Contains(t, resp.Metadata.OutputNames, "lambda_function_arn")
	assert.Contains(t, resp.Metadata.OutputNames, "s3_bucket_arn")
	assert.Contains(t, resp.Metadata.OutputNames, "lambda_role_arn")

	// Should have resources from main.tf (but not data sources)
	assert.Equal(t, 5, len(resp.Metadata.ResourceNames), "should have 5 resources")
	assert.Contains(t, resp.Metadata.ResourceNames, "aws_lambda_function.this")
	assert.Contains(t, resp.Metadata.ResourceNames, "aws_iam_role.lambda")
	assert.Contains(t, resp.Metadata.ResourceNames, "aws_s3_bucket.this")
	assert.Contains(t, resp.Metadata.ResourceNames, "aws_s3_bucket_versioning.this")
	assert.Contains(t, resp.Metadata.ResourceNames, "aws_s3_bucket_notification.this")
}

func TestHandleTfModuleParse_ModuleWithOutputsAndResources(t *testing.T) {
	// Use s3-bucket fixture which has outputs and resources
	fixtureDir, err := filepath.Abs("../testdata/test-fixtures/tf-modules/s3-bucket")
	require.NoError(t, err)

	gruntbookPath := filepath.Join(fixtureDir, "gruntbook.mdx")

	code, body := tfParseRequest(t, gruntbookPath, TfParseRequest{
		Source: fixtureDir,
	})

	assert.Equal(t, http.StatusOK, code)

	var resp TfParseResponse
	require.NoError(t, json.Unmarshal(body, &resp))

	assert.Equal(t, "s3-bucket", resp.Metadata.FolderName)
	assert.Equal(t, "S3 Bucket Module", resp.Metadata.ReadmeTitle)
	assert.Greater(t, len(resp.Metadata.OutputNames), 0, "should have outputs")
	assert.Greater(t, len(resp.Metadata.ResourceNames), 0, "should have resources")
}

// --- resolveModuleSource unit tests ---

func TestResolveModuleSource_AbsolutePath(t *testing.T) {
	tmpDir := t.TempDir()

	localPath, cleanup, err := resolveModuleSource(tmpDir, "/some/gruntbook.mdx", nil)
	require.NoError(t, err)
	assert.Nil(t, cleanup)
	assert.Equal(t, tmpDir, localPath, "absolute paths should be returned as-is")
}

func TestResolveModuleSource_RelativePath(t *testing.T) {
	gruntbookDir := t.TempDir()
	gruntbookPath := filepath.Join(gruntbookDir, "gruntbook.mdx")

	localPath, cleanup, err := resolveModuleSource("../modules/vpc", gruntbookPath, nil)
	require.NoError(t, err)
	assert.Nil(t, cleanup)

	expected := filepath.Join(gruntbookDir, "../modules/vpc")
	assert.Equal(t, expected, localPath, "relative paths should resolve against gruntbook directory")
}

func TestResolveModuleSource_DotPath(t *testing.T) {
	gruntbookDir := t.TempDir()
	gruntbookPath := filepath.Join(gruntbookDir, "gruntbook.mdx")

	localPath, cleanup, err := resolveModuleSource(".", gruntbookPath, nil)
	require.NoError(t, err)
	assert.Nil(t, cleanup)
	assert.Equal(t, gruntbookDir, localPath, "'.' should resolve to the gruntbook directory")
}

func TestResolveModuleSource_NestedRelativePath(t *testing.T) {
	gruntbookDir := t.TempDir()
	gruntbookPath := filepath.Join(gruntbookDir, "gruntbook.mdx")

	localPath, cleanup, err := resolveModuleSource("modules/vpc", gruntbookPath, nil)
	require.NoError(t, err)
	assert.Nil(t, cleanup)

	expected := filepath.Join(gruntbookDir, "modules/vpc")
	assert.Equal(t, expected, localPath)
}
