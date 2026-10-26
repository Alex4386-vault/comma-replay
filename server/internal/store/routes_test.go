package store

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func writeFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestListRoutes(t *testing.T) {
	root := t.TempDir()
	dev := filepath.Join(root, "github_1", "dev")
	writeFile(t, filepath.Join(dev, "0000027e--11b9b83499--1", "rlog.zst"), 10)
	writeFile(t, filepath.Join(dev, "0000027e--11b9b83499--1", "qcamera.ts"), 0) // still syncing
	writeFile(t, filepath.Join(dev, "0000027e--11b9b83499--0", "qlog.zst"), 10)
	writeFile(t, filepath.Join(dev, "0000027e--11b9b83499--0", "qcamera.ts"), 10)
	if err := os.MkdirAll(filepath.Join(dev, "0000027f--aaaaaaaaaa--0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dev, "crash"), 0o755); err != nil {
		t.Fatal(err)
	}

	st, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	routes, err := st.ListRoutes("github_1", "dev")
	if err != nil {
		t.Fatal(err)
	}
	want := []Route{
		{ID: "0000027f--aaaaaaaaaa", Segments: []SegmentFiles{{Num: 0, Dir: "0000027f--aaaaaaaaaa--0", Kinds: []string{}}}},
		{ID: "0000027e--11b9b83499", Segments: []SegmentFiles{
			{Num: 0, Dir: "0000027e--11b9b83499--0", Kinds: []string{"qcamera", "qlog"}},
			{Num: 1, Dir: "0000027e--11b9b83499--1", Kinds: []string{"rlog"}},
		}},
	}
	if !reflect.DeepEqual(routes, want) {
		t.Fatalf("routes\n got %+v\nwant %+v", routes, want)
	}
	if got := routes[1].Signature(); got != "2:0," {
		t.Fatalf("signature = %q", got)
	}
}

func TestScanDeviceReusesUnchangedDirs(t *testing.T) {
	root := t.TempDir()
	seg := filepath.Join(root, "github_1", "dev", "0000027e--11b9b83499--0")
	writeFile(t, filepath.Join(seg, "qlog.zst"), 10)
	st, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.ScanDevice("github_1", "dev", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Same mtime: the previous entry is trusted without reading the dir.
	prev := Scan{"0000027e--11b9b83499--0": {ModTime: first["0000027e--11b9b83499--0"].ModTime, Kinds: []string{"marker"}}}
	again, _ := st.ScanDevice("github_1", "dev", prev)
	if got := again["0000027e--11b9b83499--0"].Kinds; !reflect.DeepEqual(got, []string{"marker"}) {
		t.Fatalf("unchanged dir was re-read: %v", got)
	}
	// A synced file bumps the dir mtime, so it is read again.
	writeFile(t, filepath.Join(seg, "qcamera.ts"), 10)
	future := time.Now().Add(time.Minute)
	if err := os.Chtimes(seg, future, future); err != nil {
		t.Fatal(err)
	}
	after, _ := st.ScanDevice("github_1", "dev", prev)
	if got := after["0000027e--11b9b83499--0"].Kinds; !reflect.DeepEqual(got, []string{"qcamera", "qlog"}) {
		t.Fatalf("changed dir kinds = %v", got)
	}
}
