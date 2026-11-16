package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var databaseEnvironmentKey = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)

type DatabaseCommand struct {
	Command []string          `json:"command"`
	Env     map[string]string `json:"env"`
	Stdin   string            `json:"stdin"`
}

// ExecDatabase streams directly from Docker. Passwords go in exec Env or stdin, never Cmd.
func (c *Client) ExecDatabase(ctx context.Context, identity DatabaseIdentity, role string, command DatabaseCommand, stdin io.Reader, stdout, stderr io.Writer, tty bool, timeout time.Duration, started func(string)) (int, error) {
	if !identity.valid() || (role != "database" && role != "pooler") || len(command.Command) == 0 || len(command.Command) > 128 || len(command.Env) > 128 || timeout < time.Second || timeout > time.Hour {
		return -1, databaseFailure("exec validation")
	}
	allowed := map[string]bool{"psql": true, "pg_dump": true, "pg_restore": true, "wal-g": true, "redis-cli": true, "du": true, "df": true}
	if !allowed[command.Command[0]] {
		return -1, databaseFailure("exec command validation")
	}
	size := len(command.Stdin)
	for _, argument := range command.Command {
		size += len(argument)
		if strings.ContainsRune(argument, 0) {
			return -1, databaseFailure("exec argument validation")
		}
	}
	for key, value := range command.Env {
		size += len(key) + len(value)
		if !databaseEnvironmentKey.MatchString(key) || strings.ContainsRune(value, 0) {
			return -1, databaseFailure("exec environment validation")
		}
	}
	if size > 65536 {
		return -1, databaseFailure("exec size validation")
	}
	if stdin == nil && command.Stdin != "" {
		stdin = strings.NewReader(command.Stdin)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()
	name := DatabaseContainerName(identity.ID, role)
	state, err := c.Inspect(ctx, name)
	if err != nil || !state.Running || !ownedDatabase(state.Labels, identity, role, true) {
		return -1, databaseFailure("exec ownership or readiness check")
	}
	env := make([]string, 0, len(command.Env))
	for key, value := range command.Env {
		env = append(env, key+"="+value)
	}
	var created struct {
		ID string `json:"Id"`
	}
	// Interactive psql supports shell escapes: app/readonly clients must not read the owner's files.
	user := "10000:10000"
	clientRole := command.Env["PGUSER"]
	if command.Command[0] == "redis-cli" {
		for i, arg := range command.Command {
			if arg == "--user" && i+1 < len(command.Command) {
				clientRole = command.Command[i+1]
			}
		}
	}
	if clientRole == "fleet_owner" {
		user = "999:999"
	} else if clientRole == "fleet_app" {
		user = "10001:10001"
	}
	args := append([]string{"timeout", "--signal=TERM", "--kill-after=5s", strconv.FormatFloat(timeout.Seconds(), 'f', 3, 64) + "s"}, command.Command...)
	if c.do(ctx, http.MethodPost, "/"+c.api(ctx)+"/containers/"+state.ID+"/exec", map[string]any{"Cmd": args, "Env": env, "User": user, "AttachStdin": stdin != nil, "AttachStdout": true, "AttachStderr": true, "Tty": tty}, &created) != nil {
		return -1, databaseFailure("exec creation")
	}
	transport, ok := c.http.Transport.(*http.Transport)
	if !ok || transport.DialContext == nil {
		return -1, databaseFailure("exec transport")
	}
	conn, err := transport.DialContext(ctx, "tcp", "docker:80")
	if err != nil {
		return -1, databaseFailure("exec transport")
	}
	defer conn.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopClose()
	body, _ := json.Marshal(map[string]bool{"Detach": false, "Tty": tty})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker/"+c.api(ctx)+"/exec/"+created.ID+"/start", bytes.NewReader(body))
	if err != nil {
		return -1, databaseFailure("exec stream setup")
	}
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "tcp")
	request.Header.Set("Content-Type", "application/json")
	if request.Write(conn) != nil {
		return -1, databaseFailure("exec stream setup")
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		return -1, databaseFailure("exec stream upgrade")
	}
	if started != nil {
		started(created.ID)
	}
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	if stdin != nil {
		go func() {
			_, _ = io.Copy(conn, stdin)
			if half, ok := conn.(interface{ CloseWrite() error }); ok {
				_ = half.CloseWrite()
			}
		}()
	}
	if tty {
		_, err = io.Copy(stdout, reader)
	} else {
		for {
			var header [8]byte
			_, err = io.ReadFull(reader, header[:])
			if err == io.EOF {
				err = nil
				break
			}
			if err != nil {
				break
			}
			length := binary.BigEndian.Uint32(header[4:])
			if (header[0] != 1 && header[0] != 2) || header[1] != 0 || header[2] != 0 || header[3] != 0 || length > 1<<20 {
				err = fmt.Errorf("invalid Docker stream frame")
				break
			}
			target := stdout
			if header[0] == 2 {
				target = stderr
			}
			if _, err = io.CopyN(target, reader, int64(length)); err != nil {
				break
			}
		}
	}
	if ctx.Err() != nil {
		return -1, ctx.Err()
	}
	if err != nil {
		return -1, databaseFailure("exec output stream")
	}
	var result struct {
		Running  bool `json:"Running"`
		ExitCode int  `json:"ExitCode"`
	}
	if c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/exec/"+created.ID+"/json", nil, &result) != nil || result.Running {
		return -1, databaseFailure("exec completion check; inspect the operation before retrying")
	}
	return result.ExitCode, nil
}

func (c *Client) ResizeDatabaseExec(ctx context.Context, identity DatabaseIdentity, role, execID string, columns, rows int) error {
	if !identity.valid() || (role != "database" && role != "pooler") || len(execID) != 64 || columns < 1 || columns > 1000 || rows < 1 || rows > 1000 {
		return databaseFailure("terminal resize validation")
	}
	for _, ch := range execID {
		if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
			return databaseFailure("terminal resize validation")
		}
	}
	state, err := c.Inspect(ctx, DatabaseContainerName(identity.ID, role))
	if err != nil || !ownedDatabase(state.Labels, identity, role, true) {
		return databaseFailure("terminal ownership check")
	}
	var execution struct {
		ContainerID string `json:"ContainerID"`
		Running     bool   `json:"Running"`
	}
	if c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/exec/"+execID+"/json", nil, &execution) != nil || execution.ContainerID != state.ID || !execution.Running {
		return databaseFailure("terminal session check")
	}
	if c.do(ctx, http.MethodPost, fmt.Sprintf("/%s/exec/%s/resize?w=%d&h=%d", c.api(ctx), execID, columns, rows), nil, nil) != nil {
		return databaseFailure("terminal resize")
	}
	return nil
}
