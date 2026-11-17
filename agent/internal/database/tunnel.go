// Package database handles the additive db.* tunnel protocol without host port bindings.
package database

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fleet-os/fleet-os/agent/internal/docker"
)

const frameSize = 32768
const maxWindow = 16

var wireID = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)

type Message struct {
	Window    int                       `json:"window,omitempty"`
	Type      string                    `json:"type"`
	Version   int                       `json:"version"`
	ID        string                    `json:"id"`
	Operation *docker.DatabaseOperation `json:"operation,omitempty"`
	Identity  docker.DatabaseIdentity   `json:"identity,omitempty"`
	Command   *docker.DatabaseCommand   `json:"command,omitempty"`
	Role      string                    `json:"role,omitempty"`
	Port      int                       `json:"port,omitempty"`
	TTY       bool                      `json:"tty,omitempty"`
	TimeoutMS int                       `json:"timeoutMs,omitempty"`
	Columns   int                       `json:"columns,omitempty"`
	Rows      int                       `json:"rows,omitempty"`
	Seq       int                       `json:"seq,omitempty"`
	Data      string                    `json:"data,omitempty"`
}

type Event struct {
	Window    int                     `json:"window,omitempty"`
	Type      string                  `json:"type"`
	Version   int                     `json:"version"`
	ID        string                  `json:"id"`
	Seq       int                     `json:"seq,omitempty"`
	Data      string                  `json:"data,omitempty"`
	Channel   string                  `json:"channel,omitempty"`
	ExitCode  *int                    `json:"exitCode,omitempty"`
	ErrorCode string                  `json:"errorCode,omitempty"`
	Receipt   *docker.DatabaseReceipt `json:"receipt,omitempty"`
}

type Handler struct {
	Runtime    *docker.DatabaseRuntime
	Send       func(context.Context, Event)
	mu         sync.Mutex
	streams    map[string]*stream
	operations map[string]context.CancelFunc
}

type packet struct {
	seq  int
	data []byte
	eof  bool
}
type stream struct {
	ctx       context.Context
	cancel    context.CancelFunc
	request   Message
	input     chan packet
	ack       chan int
	inputSeq  int
	eof       bool
	execID    string
	mu        sync.Mutex
	writeMu   sync.Mutex
	outputSeq int
	outputAck int
	window    int
	drained   atomic.Int64
	current   packet
	offset    int
}

func (h *Handler) emit(ctx context.Context, event Event) {
	event.Version = 1
	if ctx.Err() == nil {
		h.Send(ctx, event)
	}
}
func (h *Handler) fail(ctx context.Context, id, code string) {
	h.emit(ctx, Event{Type: "db.closed", ID: id, ErrorCode: code})
}

func (h *Handler) Handle(ctx context.Context, body []byte) {
	if len(body) > 1048576 || h.Runtime == nil || h.Send == nil {
		return
	}
	var message Message
	if json.Unmarshal(body, &message) != nil || message.Version != 1 || !wireID.MatchString(message.ID) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.streams == nil {
		h.streams = map[string]*stream{}
		h.operations = map[string]context.CancelFunc{}
	}
	switch message.Type {
	case "db.operation":
		if message.Operation == nil || h.operations[message.ID] != nil || h.streams[message.ID] != nil || len(h.operations) >= 2 {
			h.emit(ctx, Event{Type: "db.result", ID: message.ID, ErrorCode: "operation_rejected"})
			return
		}
		work, cancel := context.WithTimeout(ctx, 10*time.Minute)
		h.operations[message.ID] = cancel
		go func() {
			defer cancel()
			defer func() { h.mu.Lock(); delete(h.operations, message.ID); h.mu.Unlock() }()
			receipt, err := h.Runtime.Apply(work, *message.Operation)
			if err != nil {
				h.emit(ctx, Event{Type: "db.result", ID: message.ID, ErrorCode: docker.DatabaseOperationErrorCode(err)})
				return
			}
			h.emit(ctx, Event{Type: "db.result", ID: message.ID, Receipt: receipt})
		}()
	case "db.operation.cancel":
		if cancel := h.operations[message.ID]; cancel != nil {
			cancel()
		}
	case "db.exec.open", "db.tcp.open":
		if h.streams[message.ID] != nil || h.operations[message.ID] != nil || len(h.streams) >= 8 || (message.Role != "database" && message.Role != "pooler") {
			h.fail(ctx, message.ID, "session_rejected")
			return
		}
		if message.TimeoutMS == 0 {
			message.TimeoutMS = 600000
		}
		if message.TimeoutMS < 1000 || message.TimeoutMS > 3600000 {
			h.fail(ctx, message.ID, "session_deadline_invalid")
			return
		}
		if message.Type == "db.tcp.open" {
			if (message.Role == "pooler" && message.Port != 6432) || (message.Role == "database" && message.Port != 5432 && message.Port != 6379) {
				h.fail(ctx, message.ID, "database_port_invalid")
				return
			}
			message.Command = &docker.DatabaseCommand{Command: []string{"fleet-db-proxy", strconv.Itoa(message.Port)}}
			message.TTY = false
		}
		if message.Command == nil {
			h.fail(ctx, message.ID, "session_command_missing")
			return
		}
		work, cancel := context.WithTimeout(ctx, time.Duration(message.TimeoutMS)*time.Millisecond)
		window := 1
		if message.Window == maxWindow {
			window = maxWindow
		}
		session := &stream{ctx: work, cancel: cancel, request: message, window: window, input: make(chan packet, window+1), ack: make(chan int, window)}
		h.streams[message.ID] = session
		go h.run(ctx, session)
	case "db.data":
		session := h.streams[message.ID]
		if session == nil {
			return
		}
		data, err := base64.StdEncoding.Strict().DecodeString(message.Data)
		if err != nil || base64.StdEncoding.EncodeToString(data) != message.Data || len(data) == 0 || len(data) > frameSize || message.Seq != session.inputSeq+1 || session.inputSeq-int(session.drained.Load()) >= session.window || session.eof {
			session.cancel()
			return
		}
		select {
		case session.input <- packet{seq: message.Seq, data: data}:
			session.inputSeq = message.Seq
		default:
			session.cancel()
		}
	case "db.eof":
		if session := h.streams[message.ID]; session != nil && !session.eof {
			session.eof = true
			select {
			case session.input <- packet{eof: true}:
			default:
				session.cancel()
			}
		}
	case "db.ack":
		if session := h.streams[message.ID]; session != nil {
			select {
			case session.ack <- message.Seq:
			default:
				session.cancel()
			}
		}
	case "db.resize":
		if session := h.streams[message.ID]; session != nil && session.request.TTY {
			session.mu.Lock()
			execID := session.execID
			session.mu.Unlock()
			go func() {
				if h.Runtime.Docker.ResizeDatabaseExec(session.ctx, session.request.Identity, session.request.Role, execID, message.Columns, message.Rows) != nil {
					session.cancel()
				}
			}()
		}
	case "db.close":
		if session := h.streams[message.ID]; session != nil {
			session.cancel()
		}
	}
}

func (h *Handler) run(parent context.Context, s *stream) {
	defer s.cancel()
	defer func() { h.mu.Lock(); delete(h.streams, s.request.ID); h.mu.Unlock() }()
	if h.Runtime.CheckIdentity(s.request.Identity) != nil {
		h.fail(parent, s.request.ID, "database_scope_invalid")
		return
	}
	reader := &streamReader{handler: h, stream: s}
	output := &streamWriter{handler: h, stream: s, channel: "stdout"}
	stderr := &streamWriter{handler: h, stream: s, channel: "stderr"}
	code, err := h.Runtime.Docker.ExecDatabase(s.ctx, s.request.Identity, s.request.Role, *s.request.Command, reader, output, stderr, s.request.TTY, time.Duration(s.request.TimeoutMS)*time.Millisecond, func(id string) {
		s.mu.Lock()
		s.execID = id
		s.mu.Unlock()
		h.emit(parent, Event{Type: "db.opened", ID: s.request.ID, Window: s.window})
	})
	if err == nil {
		err = s.flush()
	}
	event := Event{Type: "db.closed", ID: s.request.ID, ExitCode: &code}
	if err != nil {
		event.ErrorCode = "session_interrupted"
	}
	h.emit(parent, event)
}

type streamReader struct {
	handler *Handler
	stream  *stream
}

func (r *streamReader) Read(out []byte) (int, error) {
	s := r.stream
	if s.current.eof {
		return 0, io.EOF
	}
	if s.offset == len(s.current.data) {
		select {
		case <-s.ctx.Done():
			return 0, s.ctx.Err()
		case s.current = <-s.input:
			s.offset = 0
		}
		if s.current.eof {
			return 0, io.EOF
		}
	}
	n := copy(out, s.current.data[s.offset:])
	s.offset += n
	if s.offset == len(s.current.data) {
		s.drained.Store(int64(s.current.seq))
		r.handler.emit(s.ctx, Event{Type: "db.ack", ID: s.request.ID, Seq: s.current.seq})
	}
	return n, nil
}

type streamWriter struct {
	handler *Handler
	stream  *stream
	channel string
}

func (w *streamWriter) Write(data []byte) (int, error) {
	s := w.stream
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	written := 0
	for len(data) > 0 {
		n := len(data)
		if n > frameSize {
			n = frameSize
		}
		if s.outputSeq-s.outputAck >= s.window {
			if err := s.waitCredit(); err != nil {
				return written, err
			}
		}
		s.outputSeq++
		w.handler.emit(s.ctx, Event{Type: "db.data", ID: s.request.ID, Seq: s.outputSeq, Data: base64.StdEncoding.EncodeToString(data[:n]), Channel: w.channel})
		written += n
		data = data[n:]
	}
	return written, nil
}

func (s *stream) waitCredit() error {
	select {
	case <-s.ctx.Done():
		return s.ctx.Err()
	case seq := <-s.ack:
		if seq != s.outputAck+1 || seq > s.outputSeq {
			s.cancel()
			return errors.New("database stream acknowledgement mismatch")
		}
		s.outputAck = seq
		return nil
	}
}
func (s *stream) flush() error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for s.outputAck < s.outputSeq {
		if err := s.waitCredit(); err != nil {
			return err
		}
	}
	return nil
}
