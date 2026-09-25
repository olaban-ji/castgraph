// Package telegram tells a chat what the catalog jobs are doing.
//
// Two kinds of message, because a phone only buzzes for a new one.
// A change of state — an import starting, a job catching up, a failure,
// a catalog gone stale — is a new message, and it carries a snapshot of
// every job so the buzz itself answers "what else is running?". Progress
// inside a job that has already announced itself is written into one
// standing message, edited in place and at most once a minute. Editing
// does not buzz, which is what keeps a five-second log line from
// becoming a few hundred notifications.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"cinedikt/internal/notify"
)

// boardEvery is the most often the standing message is rewritten.
// Often enough that a long poster pass does not look frozen, rare
// enough to stay inside what Telegram will accept for one chat.
const boardEvery = time.Minute

// jobOrder is the order the standing message lists jobs. A job that
// has not spoken yet is left out, so a quiet one does not read as idle.
var jobOrder = []struct{ id, label string }{
	{notify.JobImport, "import"},
	{notify.JobPosters, "posters"},
	{notify.JobTMDbPosters, "tmdb posters"},
	{notify.JobTMDbIDs, "tmdb ids"},
	{notify.JobColours, "colours"},
}

// Start posts events to chatID for as long as ctx lasts. An empty token
// or an empty chat is silence, which is what a machine without the
// variables set should do. One of the two being set is a misconfiguration
// and is logged, because a token with nowhere to send it looks exactly
// like a bot that is broken.
func Start(ctx context.Context, token, chatID string, logger *slog.Logger) notify.Sink {
	token = strings.TrimSpace(token)
	chatID = strings.TrimSpace(chatID)
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if token == "" && chatID == "" {
		return nil
	}
	if token == "" || chatID == "" {
		logger.Warn("telegram notifications are off", "reason", "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set")
		return nil
	}
	s := &Sink{
		token:  token,
		chatID: chatID,
		logger: logger,
		client: &http.Client{Timeout: 5 * time.Second},
		base:   "https://api.telegram.org",
		every:  boardEvery,
		now:    time.Now,
		line:   map[string]string{},
		wake:   make(chan struct{}, 1),
	}
	go s.loop(ctx)
	logger.Info("telegram notifications on")
	return s
}

// Sink is a notify.Sink. The zero value is not useful; Start builds one.
type Sink struct {
	token  string
	chatID string
	logger *slog.Logger
	client *http.Client
	base   string
	every  time.Duration
	now    func() time.Time

	wake chan struct{}

	mu         sync.Mutex
	line       map[string]string
	pushes     []string
	dirty      bool
	dirtySince time.Time
	lastBoard  string
	lastEdit   time.Time
	boardID    int
}

// Note records the event and returns. The HTTP happens on the sink's
// own goroutine, so a slow Telegram cannot stall an import.
func (s *Sink) Note(e notify.Event) {
	if s == nil || e.Text == "" {
		return
	}
	s.mu.Lock()
	if !notify.Pushes(e.Kind) && s.line[e.Job] == e.Text {
		s.mu.Unlock()
		return
	}
	s.line[e.Job] = e.Text
	s.dirty = true
	if s.dirtySince.IsZero() {
		s.dirtySince = s.now()
	}
	if notify.Pushes(e.Kind) {
		s.pushes = append(s.pushes, s.pushBody(e))
	}
	s.mu.Unlock()
	s.kick()
}

func (s *Sink) kick() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Sink) loop(ctx context.Context) {
	var timer *time.Timer
	var timerC <-chan time.Time
	stop := func() {
		if timer == nil {
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer = nil
		timerC = nil
	}
	defer stop()
	arm := func() {
		if timerC != nil {
			return
		}
		timer = time.NewTimer(s.every)
		timerC = timer.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
			if s.deliver(ctx) {
				stop()
			} else {
				arm()
			}
		case <-timerC:
			timer = nil
			timerC = nil
			s.flushBoard(ctx)
		}
	}
}

// deliver sends any pending pushes and, when one of them went out or
// the board is already due, rewrites the standing message. It reports
// whether the board was rewritten, so the caller can drop a timer that
// would otherwise edit it again immediately.
func (s *Sink) deliver(ctx context.Context) bool {
	if s.sendPushes(ctx) || s.due() {
		s.flushBoard(ctx)
		return true
	}
	return !s.isDirty()
}

func (s *Sink) sendPushes(ctx context.Context) bool {
	s.mu.Lock()
	batch := s.pushes
	s.pushes = nil
	s.mu.Unlock()
	for _, text := range batch {
		if _, err := s.sendMessage(ctx, text, false); err != nil {
			s.logger.Warn("telegram", "err", s.scrub(err))
		}
	}
	return len(batch) > 0
}

func (s *Sink) due() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty || s.dirtySince.IsZero() {
		return false
	}
	if !s.lastEdit.IsZero() && s.now().Sub(s.lastEdit) < s.every {
		return false
	}
	return s.now().Sub(s.dirtySince) >= s.every
}

func (s *Sink) isDirty() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dirty
}

func (s *Sink) flushBoard(ctx context.Context) {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return
	}
	text := s.boardText()
	id := s.boardID
	if text == s.lastBoard {
		s.dirty = false
		s.dirtySince = time.Time{}
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	var newID int
	var err error
	if id == 0 {
		// The push, when there was one, already buzzed. This message
		// is the one that later edits land on, and it should not buzz
		// a second time for the same news.
		newID, err = s.sendMessage(ctx, text, true)
	} else {
		err = s.editMessage(ctx, id, text)
		if isGone(err) {
			newID, err = s.sendMessage(ctx, text, true)
		}
	}
	if isNotModified(err) {
		err = nil
	}
	if err != nil {
		s.logger.Warn("telegram", "err", s.scrub(err))
		return
	}

	s.mu.Lock()
	s.lastBoard = text
	s.lastEdit = s.now()
	if s.boardText() == text {
		s.dirty = false
		s.dirtySince = time.Time{}
	}
	if newID != 0 {
		s.boardID = newID
	}
	s.mu.Unlock()
}

// pushBody is the headline plus a snapshot of every job, taken under
// the lock Note already holds.
func (s *Sink) pushBody(e notify.Event) string {
	head := clip(headline(e), 500)
	board := s.boardText()
	if board == "" {
		return head
	}
	return clip(head+"\n\n"+board, 4000)
}

func (s *Sink) boardText() string {
	var b strings.Builder
	for _, job := range jobOrder {
		text, ok := s.line[job.id]
		if !ok || text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		fmt.Fprintf(&b, "%-13s %s", job.label, clip(text, 500))
	}
	return b.String()
}

func headline(e notify.Event) string {
	switch e.Kind {
	case notify.Started:
		return label(e.Job) + " started — " + oneLine(e.Text)
	case notify.Published:
		return "import published — " + oneLine(e.Text)
	case notify.Failed:
		return label(e.Job) + " failed — " + oneLine(e.Text)
	case notify.Stale:
		return "catalog is stale — " + oneLine(e.Text)
	case notify.CaughtUp:
		return label(e.Job) + " caught up — " + oneLine(e.Text)
	case notify.Paused:
		return label(e.Job) + " paused — " + oneLine(e.Text)
	default:
		return label(e.Job) + " — " + oneLine(e.Text)
	}
}

func label(job string) string {
	for _, j := range jobOrder {
		if j.id == job {
			return j.label
		}
	}
	return job
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n < 3 {
		return s[:n]
	}
	return s[:n-3] + "..."
}

type outbound struct {
	ChatID              string `json:"chat_id"`
	Text                string `json:"text"`
	DisableNotification bool   `json:"disable_notification,omitempty"`
	MessageID           int    `json:"message_id,omitempty"`
}

type apiResponse struct {
	OK          bool   `json:"ok"`
	Description string `json:"description"`
	Result      struct {
		MessageID int `json:"message_id"`
	} `json:"result"`
}

func (s *Sink) sendMessage(ctx context.Context, text string, silent bool) (int, error) {
	return s.call(ctx, "sendMessage", outbound{
		ChatID:              s.chatID,
		Text:                text,
		DisableNotification: silent,
	})
}

func (s *Sink) editMessage(ctx context.Context, id int, text string) error {
	_, err := s.call(ctx, "editMessageText", outbound{
		ChatID:    s.chatID,
		Text:      text,
		MessageID: id,
	})
	return err
}

func (s *Sink) call(ctx context.Context, method string, body outbound) (int, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+"/bot"+s.token+"/"+method, bytes.NewReader(raw))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return 0, err
	}
	var out apiResponse
	if err := json.Unmarshal(payload, &out); err != nil {
		return 0, fmt.Errorf("telegram: %s: HTTP %d", method, resp.StatusCode)
	}
	if !out.OK {
		return 0, fmt.Errorf("telegram: %s", out.Description)
	}
	return out.Result.MessageID, nil
}

func (s *Sink) scrub(err error) error {
	if err == nil {
		return nil
	}
	return errors.New(strings.ReplaceAll(err.Error(), s.token, "…"))
}

func isNotModified(err error) bool {
	return err != nil && strings.Contains(err.Error(), "message is not modified")
}

func isGone(err error) bool {
	return err != nil && strings.Contains(err.Error(), "message to edit not found")
}
