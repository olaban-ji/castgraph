package telegram

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"cinedikt/internal/notify"
)

func TestStartIsSilentWithoutBothSettings(t *testing.T) {
	if Start(context.Background(), "", "", nil) != nil {
		t.Fatal("an unconfigured sink was started")
	}
	var buf strings.Builder
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	if Start(context.Background(), "token", "", logger) != nil {
		t.Fatal("a token with no chat was started")
	}
	if !strings.Contains(buf.String(), "must both be set") {
		t.Fatalf("log = %q, want the reason both settings are required", buf.String())
	}
}

func TestWorkingWaitsAndAStartPushesWithTheOthers(t *testing.T) {
	var calls []captured
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, capture(t, r))
		writeAPI(w, len(calls))
	}))
	defer srv.Close()

	now := time.Now()
	s := testSink(srv.URL, func() time.Time { return now })

	s.Note(notify.Event{Job: notify.JobPosters, Kind: notify.Working, Text: "41% · 12m left"})
	if s.deliver(context.Background()) {
		t.Fatal("a progress tick rewrote the board immediately")
	}
	if len(calls) != 0 {
		t.Fatalf("telegram was called %d times for a progress tick", len(calls))
	}

	s.Note(notify.Event{Job: notify.JobImport, Kind: notify.Started, Text: "downloading"})
	if !s.deliver(context.Background()) {
		t.Fatal("a start did not send")
	}
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want the push and the standing message", len(calls))
	}
	push := calls[0]
	if push.method != "sendMessage" || push.silent {
		t.Fatalf("push = %+v, want a notifying sendMessage", push)
	}
	if !strings.Contains(push.text, "import started — downloading") || !strings.Contains(push.text, "41% · 12m left") {
		t.Fatalf("push text = %q, want the start and the other job", push.text)
	}
	board := calls[1]
	if board.method != "sendMessage" || !board.silent {
		t.Fatalf("board = %+v, want a silent standing message", board)
	}
	if !strings.HasPrefix(board.text, "import") || !strings.Contains(board.text, "posters") {
		t.Fatalf("board text = %q, want both jobs", board.text)
	}

	s.Note(notify.Event{Job: notify.JobPosters, Kind: notify.Working, Text: "55% · 8m left"})
	if s.deliver(context.Background()) {
		t.Fatal("the board was rewritten before a minute had passed")
	}
	now = now.Add(boardEvery)
	if !s.deliver(context.Background()) {
		t.Fatal("the board was not rewritten once it was due")
	}
	if len(calls) != 3 || calls[2].method != "editMessageText" || calls[2].messageID != 2 {
		t.Fatalf("edit = %+v, want editMessageText of the standing message", calls[2:])
	}
	if !strings.Contains(calls[2].text, "55% · 8m left") {
		t.Fatalf("edited text = %q, want the later progress", calls[2].text)
	}
}

func TestALostStandingMessageIsSentAgain(t *testing.T) {
	var n int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		body := capture(t, r)
		if body.method == "editMessageText" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"ok":false,"description":"Bad Request: message to edit not found"}`)
			return
		}
		writeAPI(w, n)
	}))
	defer srv.Close()

	s := testSink(srv.URL, time.Now)
	s.Note(notify.Event{Job: notify.JobImport, Kind: notify.Started, Text: "downloading"})
	s.deliver(context.Background())
	s.Note(notify.Event{Job: notify.JobImport, Kind: notify.Working, Text: "loading"})
	s.mu.Lock()
	s.dirtySince = s.now().Add(-boardEvery)
	s.lastEdit = s.now().Add(-boardEvery)
	s.mu.Unlock()
	s.deliver(context.Background())

	s.mu.Lock()
	id := s.boardID
	s.mu.Unlock()
	if id == 0 {
		t.Fatal("the standing message was not replaced after Telegram had lost it")
	}
}

func TestTheTokenDoesNotAppearInALoggedError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("no hijacker")
		}
		conn, _, _ := hj.Hijack()
		conn.Close()
	}))
	defer srv.Close()

	var buf strings.Builder
	s := testSink(srv.URL, time.Now)
	s.logger = slog.New(slog.NewTextHandler(&buf, nil))
	s.token = "secret-token"
	s.Note(notify.Event{Job: notify.JobImport, Kind: notify.Failed, Text: "disk full"})
	s.deliver(context.Background())
	if strings.Contains(buf.String(), "secret-token") {
		t.Fatalf("the token was logged: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "telegram") {
		t.Fatalf("log = %q, want the failure recorded", buf.String())
	}
}

type captured struct {
	method    string
	text      string
	silent    bool
	messageID int
}

func capture(t *testing.T, r *http.Request) captured {
	t.Helper()
	var body outbound
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	method := r.URL.Path
	if i := strings.LastIndex(method, "/"); i >= 0 {
		method = method[i+1:]
	}
	return captured{method: method, text: body.Text, silent: body.DisableNotification, messageID: body.MessageID}
}

func writeAPI(w http.ResponseWriter, id int) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = fmtInt(w, id)
}

func fmtInt(w io.Writer, id int) (int, error) {
	return io.WriteString(w, `{"ok":true,"result":{"message_id":`+itoa(id)+`}}`)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func testSink(base string, now func() time.Time) *Sink {
	return &Sink{
		token:  "token",
		chatID: "1",
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		client: &http.Client{Timeout: 5 * time.Second},
		base:   base,
		every:  boardEvery,
		now:    now,
		line:   map[string]string{},
		wake:   make(chan struct{}, 1),
	}
}
