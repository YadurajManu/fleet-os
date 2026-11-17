package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestDatabaseExecStreamsStdinAndSeparatesReadonlyOSIdentity(t *testing.T) {
	spec := databaseTestSpec()
	secret := "disposable-stdin-value"
	received := make(chan string, 1)
	execID := strings.Repeat("a", 64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/containers/"+DatabaseContainerName(spec.Identity.ID, "database")+"/json"):
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": "database", "State": map[string]bool{"Running": true}, "Config": map[string]any{"Labels": databaseLabels(spec.Identity, "database")}})
		case strings.HasSuffix(r.URL.Path, "/containers/database/exec"):
			var b struct {
				Cmd, Env    []string
				User        string
				AttachStdin bool
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			if b.User != "10000:10000" || !b.AttachStdin || b.Cmd[0] != "fleet-db-proxy" || b.Cmd[1] != "exec" || len(b.Cmd[2]) != 32 || strings.Contains(strings.Join(b.Cmd, " "), secret) {
				t.Error("exec lost role isolation, deadline or argv secrecy")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"Id": execID})
		case strings.HasSuffix(r.URL.Path, "/start"):
			_, _ = io.Copy(io.Discard, r.Body)
			conn, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			_, _ = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
			_ = buffer.Flush()
			data, _ := io.ReadAll(conn)
			received <- string(data)
			header := []byte{1, 0, 0, 0, 0, 0, 0, 0}
			binary.BigEndian.PutUint32(header[4:], 6)
			_, _ = conn.Write(append(header, []byte("answer")...))
		case strings.HasSuffix(r.URL.Path, "/exec/"+execID+"/json"):
			_, _ = w.Write([]byte(`{"Running":false,"ExitCode":0}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	c := &Client{apiVersion: "v1.44", http: &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", target.Host)
	}}}}
	var output bytes.Buffer
	code, err := c.ExecDatabase(t.Context(), spec.Identity, "database", DatabaseCommand{Command: []string{"psql", "-X"}, Env: map[string]string{"PGUSER": "fleet_readonly", "PGPASSWORD": "credential-in-env"}}, strings.NewReader(secret), &output, nil, false, time.Second, nil)
	if err != nil || code != 0 || output.String() != "answer" || <-received != secret {
		t.Fatal("exec stream or exit result was not preserved", err)
	}
}

func TestDatabaseExecRejectsArbitraryProgramsBeforeDocker(t *testing.T) {
	spec := databaseTestSpec()
	c := &Client{}
	if _, err := c.ExecDatabase(t.Context(), spec.Identity, "database", DatabaseCommand{Command: []string{"sh", "-c", "cat /etc/fleet/owner-password"}}, nil, nil, nil, false, time.Second, nil); err == nil {
		t.Fatal("arbitrary database program was allowed")
	}
}
