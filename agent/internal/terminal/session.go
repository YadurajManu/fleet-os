package terminal

import (
	"log/slog"
	"sync"
)

type Session interface {
	Write(data []byte) error
	Resize(cols, rows uint16) error
	Close() error
}

type OutputHandler func(sessionID string, data []byte)
type CloseHandler func(sessionID string)

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]Session
	log      *slog.Logger
	onOutput OutputHandler
	onClose  CloseHandler
}

func NewManager(log *slog.Logger, onOutput OutputHandler, onClose CloseHandler) *Manager {
	return &Manager{
		sessions: make(map[string]Session),
		log:      log,
		onOutput: onOutput,
		onClose:  onClose,
	}
}

func (m *Manager) Start(sessionID string, cols, rows uint16, shell string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.sessions[sessionID]; ok {
		_ = existing.Close()
		delete(m.sessions, sessionID)
	}

	sess, err := startOSSession(sessionID, cols, rows, shell, func(data []byte) {
		if m.onOutput != nil {
			m.onOutput(sessionID, data)
		}
	}, func() {
		m.mu.Lock()
		delete(m.sessions, sessionID)
		m.mu.Unlock()
		if m.onClose != nil {
			m.onClose(sessionID)
		}
	}, m.log)

	if err != nil {
		return err
	}

	m.sessions[sessionID] = sess
	return nil
}

func (m *Manager) HandleInput(sessionID string, data []byte) error {
	m.mu.RLock()
	sess, ok := m.sessions[sessionID]
	m.mu.RUnlock()

	if !ok {
		return nil
	}
	return sess.Write(data)
}

func (m *Manager) Resize(sessionID string, cols, rows uint16) error {
	m.mu.RLock()
	sess, ok := m.sessions[sessionID]
	m.mu.RUnlock()

	if !ok {
		return nil
	}
	return sess.Resize(cols, rows)
}

func (m *Manager) Close(sessionID string) {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if ok {
		_ = sess.Close()
	}
}

func (m *Manager) CloseAll() {
	m.mu.Lock()
	toClose := make([]Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		toClose = append(toClose, s)
	}
	m.sessions = make(map[string]Session)
	m.mu.Unlock()

	for _, s := range toClose {
		_ = s.Close()
	}
}
