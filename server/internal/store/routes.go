package store

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// File kinds the SPA cares about, by on-disk name (see src/route/patterns.ts).
var kindByName = map[string]string{
	"rlog.zst": "rlog", "rlog.bz2": "rlog", "rlog": "rlog",
	"qlog.zst": "qlog", "qlog.bz2": "qlog", "qlog": "qlog",
	"qcamera.ts":   "qcamera",
	"fcamera.hevc": "fcamera",
	"ecamera.hevc": "ecamera",
	"dcamera.hevc": "dcamera",
}

// {log_id}--{segment}, log_id being a timestamp or a {count}--{uid} route id.
var segmentDir = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}--\d{2}-\d{2}-\d{2}|[0-9a-f]{8}--[a-z0-9]{10})--(\d+)$`)

var skipDirs = map[string]bool{"boot": true, "crash": true}

type SegmentFiles struct {
	Num int `json:"n"`
	// Dir is the record directory serving this segment's files.
	Dir string `json:"dir"`
	// Kinds present in the segment: rlog, qlog, qcamera, fcamera, ecamera, dcamera.
	Kinds []string `json:"kinds"`
}

type Route struct {
	ID       string         `json:"id"`
	Segments []SegmentFiles `json:"segments"`
}

func (r Route) has(seg SegmentFiles, kind string) bool {
	for _, k := range seg.Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

// Signature changes whenever the route's qlog coverage does, which is what
// drive meta (time, GPS, places) is computed from.
func (r Route) Signature() string {
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(r.Segments)))
	b.WriteString(":")
	for _, s := range r.Segments {
		if r.has(s, "qlog") {
			b.WriteString(strconv.Itoa(s.Num))
			b.WriteString(",")
		}
	}
	return b.String()
}

// ScanEntry is one record dir's file kinds, as of its modification time.
type ScanEntry struct {
	ModTime int64    `json:"m"`
	Kinds   []string `json:"k"`
}

// Scan maps a device's record dir names to their file kinds.
type Scan map[string]ScanEntry

// ScanDevice lists a device's record dirs and their file kinds. Dirs whose
// mtime matches prev are reused without reading them: a sync adds files to a
// dir (bumping its mtime), and on a slow mount re-reading thousands of segment
// dirs takes tens of seconds.
func (s *Store) ScanDevice(userID, deviceID string, prev Scan) (Scan, error) {
	names, err := s.ListRecords(userID, deviceID)
	if err != nil {
		return nil, err
	}
	base, err := s.userRoot(userID)
	if err != nil {
		return nil, err
	}
	devDir := filepath.Join(base, deviceID)

	var mu sync.Mutex
	out := make(Scan, len(names))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for _, name := range names {
		if skipDirs[name] {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(name string) {
			defer wg.Done()
			defer func() { <-sem }()
			dir := filepath.Join(devDir, name)
			fi, err := os.Stat(dir)
			if err != nil {
				return
			}
			e, ok := prev[name]
			if !ok || e.ModTime != fi.ModTime().UnixNano() {
				e = ScanEntry{ModTime: fi.ModTime().UnixNano(), Kinds: dirKinds(dir)}
			}
			mu.Lock()
			out[name] = e
			mu.Unlock()
		}(name)
	}
	wg.Wait()
	return out, nil
}

// RoutesFromScan groups record dirs into routes, newest route first. Dirs that
// are not segments are their own route.
func RoutesFromScan(scan Scan) []Route {
	byID := make(map[string]*Route)
	for name, e := range scan {
		id, num := name, 0
		if m := segmentDir.FindStringSubmatch(name); m != nil {
			id = m[1]
			num, _ = strconv.Atoi(m[2])
		}
		r, ok := byID[id]
		if !ok {
			r = &Route{ID: id}
			byID[id] = r
		}
		r.Segments = append(r.Segments, SegmentFiles{Num: num, Dir: name, Kinds: e.Kinds})
	}
	out := make([]Route, 0, len(byID))
	for _, r := range byID {
		sort.Slice(r.Segments, func(a, b int) bool { return r.Segments[a].Num < r.Segments[b].Num })
		out = append(out, *r)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID > out[b].ID })
	return out
}

// ListRoutes scans a device from scratch.
func (s *Store) ListRoutes(userID, deviceID string) ([]Route, error) {
	scan, err := s.ScanDevice(userID, deviceID, nil)
	if err != nil {
		return nil, err
	}
	return RoutesFromScan(scan), nil
}

func dirKinds(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	seen := make(map[string]bool)
	out := make([]string, 0, 6)
	for _, e := range entries {
		k, ok := kindByName[e.Name()]
		if !ok || e.IsDir() || seen[k] {
			continue
		}
		// A zero-byte file is a sync that hasn't landed yet.
		if fi, err := e.Info(); err != nil || fi.Size() == 0 {
			continue
		}
		seen[k] = true
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
