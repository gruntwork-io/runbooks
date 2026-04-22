package adapters

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestOsFileSystem_WriteRead(t *testing.T) {
	fs := NewOsFileSystem()
	dir := t.TempDir()
	path := filepath.Join(dir, "hello.txt")
	want := []byte("hello, world")

	if err := fs.Write(path, want, 0o600); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got, err := fs.Read(path)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("Read = %q, want %q", got, want)
	}
}

func TestOsFileSystem_StatReadDir(t *testing.T) {
	f := NewOsFileSystem()
	dir := t.TempDir()

	if err := f.Write(filepath.Join(dir, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := f.Write(filepath.Join(dir, "b.txt"), []byte("b"), 0o600); err != nil {
		t.Fatalf("Write: %v", err)
	}

	info, err := f.Stat(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Size() != 1 {
		t.Errorf("Stat size = %d, want 1", info.Size())
	}

	entries, err := f.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("ReadDir returned %d entries, want 2", len(entries))
	}
}

func TestOsFileSystem_MkdirAllRemoveAll(t *testing.T) {
	f := NewOsFileSystem()
	root := t.TempDir()

	nested := filepath.Join(root, "a", "b", "c")
	if err := f.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if _, err := f.Stat(nested); err != nil {
		t.Fatalf("Stat nested: %v", err)
	}

	if err := f.RemoveAll(filepath.Join(root, "a")); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}
	if _, err := f.Stat(filepath.Join(root, "a")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("after RemoveAll, Stat err = %v, want os.ErrNotExist", err)
	}
}

func TestOsFileSystem_WalkDir(t *testing.T) {
	f := NewOsFileSystem()
	root := t.TempDir()

	if err := f.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := f.Write(filepath.Join(root, "top.txt"), []byte("top"), 0o600); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := f.Write(filepath.Join(root, "sub", "inner.txt"), []byte("inner"), 0o600); err != nil {
		t.Fatalf("Write: %v", err)
	}

	var files []string
	err := f.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(root, path)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("WalkDir: %v", err)
	}

	wantFiles := map[string]bool{"top.txt": true, "sub/inner.txt": true}
	if len(files) != len(wantFiles) {
		t.Fatalf("WalkDir visited %v, want %d files", files, len(wantFiles))
	}
	for _, f := range files {
		if !wantFiles[f] {
			t.Errorf("unexpected file %q", f)
		}
	}
}
