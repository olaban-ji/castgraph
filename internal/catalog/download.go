package catalog

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// DownloadTimeout bounds one file. title.principals is the better part
// of a gigabyte, so this is generous; it is here to end a stalled
// connection, not to hurry a slow one.
const DownloadTimeout = 30 * time.Minute

// Download streams the five files to dir and returns their paths.
//
// Each one is written to a temporary name and moved into place, so a
// partial file is never mistaken for a complete one. Nothing is held in
// memory: a gigabyte through a buffer would be a gigabyte of resident
// memory for no reason.
func Download(ctx context.Context, client *http.Client, dir string, files []File, logger *slog.Logger) (map[File]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("catalog: make %s: %w", dir, err)
	}
	paths := make(map[File]string, len(files))
	for i, f := range files {
		logger.Info("downloading", "file", f, "of", fmt.Sprintf("%d/%d", i+1, len(files)))
		path, err := download(ctx, client, dir, f, logger)
		if err != nil {
			// Whatever landed is not a generation, so none of it is kept.
			Discard(paths)
			return nil, err
		}
		paths[f] = path
	}
	return paths, nil
}

func download(ctx context.Context, client *http.Client, dir string, f File, logger *slog.Logger) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, DownloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", UserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("catalog: GET %s: %w", f, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("catalog: GET %s: HTTP %d", f, resp.StatusCode)
	}

	final := filepath.Join(dir, string(f)+".tsv.gz")
	tmp, err := os.CreateTemp(dir, string(f)+".*.part")
	if err != nil {
		return "", fmt.Errorf("catalog: open temp for %s: %w", f, err)
	}
	// A gigabyte over a slow line is minutes of nothing to look at.
	track := newByteProgress(logger, "downloading "+string(f), resp.ContentLength)
	body := &countingReader{r: resp.Body, each: track.step}
	written, err := io.Copy(tmp, body)
	track.done(written)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("catalog: write %s: %w", f, err)
	}
	// A connection cut mid-file gives a short body with no error. The
	// length the server promised is the only way to notice here; a gzip
	// that ends early is caught again when it is read.
	if want := resp.ContentLength; want > 0 && written != want {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("catalog: %s is %d bytes, expected %d", f, written, want)
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("catalog: move %s into place: %w", f, err)
	}
	return final, nil
}

// Discard removes downloaded files. Called when the set turns out to be
// a mixture, or when the import fails: a half-generation on disk is
// worse than no generation, because the next run might trust it.
func Discard(paths map[File]string) {
	for _, p := range paths {
		os.Remove(p)
	}
}

// OpenFile opens a downloaded file for reading.
func OpenFile(path string) (*os.File, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("catalog: open %s: %w", path, err)
	}
	return f, nil
}
