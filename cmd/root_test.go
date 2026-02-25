package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCombineCleanups_AllNil(t *testing.T) {
	result := combineCleanups(nil, nil, nil)
	assert.Nil(t, result, "all nil inputs should return nil")
}

func TestCombineCleanups_NoArgs(t *testing.T) {
	result := combineCleanups()
	assert.Nil(t, result, "no args should return nil")
}

func TestCombineCleanups_SingleFunction(t *testing.T) {
	called := false
	fn := func() { called = true }

	result := combineCleanups(fn)
	require.NotNil(t, result)

	result()
	assert.True(t, called, "the cleanup function should have been called")
}

func TestCombineCleanups_MultipleFunctions(t *testing.T) {
	var callOrder []int
	fn1 := func() { callOrder = append(callOrder, 1) }
	fn2 := func() { callOrder = append(callOrder, 2) }
	fn3 := func() { callOrder = append(callOrder, 3) }

	result := combineCleanups(fn1, fn2, fn3)
	require.NotNil(t, result)

	result()
	assert.Equal(t, []int{1, 2, 3}, callOrder, "cleanups should be called in order")
}

func TestCombineCleanups_MixedNilAndNonNil(t *testing.T) {
	var callOrder []int
	fn1 := func() { callOrder = append(callOrder, 1) }
	fn2 := func() { callOrder = append(callOrder, 2) }

	result := combineCleanups(nil, fn1, nil, fn2, nil)
	require.NotNil(t, result)

	result()
	assert.Equal(t, []int{1, 2}, callOrder, "only non-nil cleanups should be called")
}

func TestCombineCleanups_SingleNil(t *testing.T) {
	result := combineCleanups(nil)
	assert.Nil(t, result)
}

func TestCombineCleanups_ActuallyCleansTempDir(t *testing.T) {
	// Simulate a real cleanup scenario: create temp dirs and verify they're removed
	dir1 := t.TempDir() // Go will clean this up anyway, but let's create a subdir
	subdir1 := filepath.Join(dir1, "sub1")
	require.NoError(t, os.Mkdir(subdir1, 0755))

	dir2 := t.TempDir()
	subdir2 := filepath.Join(dir2, "sub2")
	require.NoError(t, os.Mkdir(subdir2, 0755))

	cleanup := combineCleanups(
		func() { os.RemoveAll(subdir1) },
		func() { os.RemoveAll(subdir2) },
	)
	require.NotNil(t, cleanup)

	// Verify dirs exist before cleanup
	_, err := os.Stat(subdir1)
	require.NoError(t, err)
	_, err = os.Stat(subdir2)
	require.NoError(t, err)

	cleanup()

	// Verify dirs are removed after cleanup
	_, err = os.Stat(subdir1)
	assert.True(t, os.IsNotExist(err), "subdir1 should be removed")
	_, err = os.Stat(subdir2)
	assert.True(t, os.IsNotExist(err), "subdir2 should be removed")
}

func TestResolveWorkingDir_Temp(t *testing.T) {
	dir, cleanup, err := resolveWorkingDir("", true)
	require.NoError(t, err)
	require.NotNil(t, cleanup, "temp dir should have a cleanup function")
	defer cleanup()

	// Verify the directory was created
	info, err := os.Stat(dir)
	require.NoError(t, err)
	assert.True(t, info.IsDir())

	// Verify the cleanup removes the directory
	cleanup()
	_, err = os.Stat(dir)
	assert.True(t, os.IsNotExist(err), "cleanup should remove temp dir")
}

func TestResolveWorkingDir_Configured(t *testing.T) {
	// Use a real directory to test absolute path resolution
	existingDir := t.TempDir()

	dir, cleanup, err := resolveWorkingDir(existingDir, false)
	require.NoError(t, err)
	assert.Nil(t, cleanup, "configured dir should not have a cleanup function")

	absExpected, _ := filepath.Abs(existingDir)
	assert.Equal(t, absExpected, dir)
}

func TestResolveWorkingDir_Default(t *testing.T) {
	dir, cleanup, err := resolveWorkingDir("", false)
	require.NoError(t, err)
	assert.Nil(t, cleanup, "default dir should not have a cleanup function")

	cwd, _ := os.Getwd()
	assert.Equal(t, cwd, dir)
}

func TestResolveWorkingDir_TempOverridesConfigured(t *testing.T) {
	// When both useTempDir and configuredDir are set, temp takes precedence
	dir, cleanup, err := resolveWorkingDir("/some/configured/path", true)
	require.NoError(t, err)
	require.NotNil(t, cleanup)
	defer cleanup()

	// Should be a temp dir, not the configured path
	assert.NotEqual(t, "/some/configured/path", dir)
	assert.Contains(t, dir, "runbook-workdir-")
}
