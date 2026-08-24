package store

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Layout on disk (e.g. comma mount):
//
//	{root}/{userID}/{deviceID}/{recordID}/...
//
// This is filesystem structure only — not HTTP paths.
type Store struct {
	root string
}

func New(root string) (*Store, error) {
	root = filepath.Clean(root)
	st, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("data root %q: %w", root, err)
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("data root %q is not a directory", root)
	}
	return &Store{root: root}, nil
}

func (s *Store) userRoot(userID string) (string, error) {
	if userID == "" || strings.Contains(userID, "..") || strings.ContainsAny(userID, `/\`) {
		return "", fmt.Errorf("invalid user id")
	}
	return filepath.Join(s.root, userID), nil
}

func (s *Store) resolve(userID, deviceID, recordID, rel string) (string, error) {
	if strings.Contains(deviceID, "..") || strings.Contains(recordID, "..") {
		return "", fmt.Errorf("invalid path")
	}
	base, err := s.userRoot(userID)
	if err != nil {
		return "", err
	}
	joined := filepath.Join(base, deviceID, recordID, filepath.FromSlash(rel))
	joined = filepath.Clean(joined)
	if !strings.HasPrefix(joined, filepath.Clean(base)+string(os.PathSeparator)) && joined != filepath.Clean(base) {
		return "", fmt.Errorf("path escapes user tree")
	}
	return joined, nil
}

func (s *Store) ListDevices(userID string) ([]string, error) {
	dir, err := s.userRoot(userID)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

func (s *Store) ListRecords(userID, deviceID string) ([]string, error) {
	base, err := s.userRoot(userID)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(base, deviceID)
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

type FileEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size,omitempty"`
}

// ListRecord lists immediate children under {user}/{device}/{record}.
func (s *Store) ListRecord(userID, deviceID, recordID string) ([]FileEntry, error) {
	abs, err := s.resolve(userID, deviceID, recordID, ".")
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(abs)
	if os.IsNotExist(err) {
		return []FileEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		fi, _ := e.Info()
		var size int64
		if fi != nil && !e.IsDir() {
			size = fi.Size()
		}
		out = append(out, FileEntry{
			Name:  e.Name(),
			Path:  e.Name(),
			IsDir: e.IsDir(),
			Size:  size,
		})
	}
	return out, nil
}

func (s *Store) Open(userID, deviceID, recordID, rel string) (io.ReadSeekCloser, os.FileInfo, error) {
	abs, err := s.resolve(userID, deviceID, recordID, rel)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(abs)
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	if st.IsDir() {
		f.Close()
		return nil, nil, fmt.Errorf("is a directory")
	}
	return f, st, nil
}
