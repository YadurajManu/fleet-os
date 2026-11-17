package dbproxy

import (
	"bytes"
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestRejectNetworkTargets(t *testing.T) {
	for _, port := range []int{-1, 0, 22, 80, 65536} {
		if Run(t.Context(), port, bytes.NewReader(nil), io.Discard) == nil {
			t.Fatal("accepted non-database port")
		}
	}
}

func TestFullDuplexHalfClose(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	payload := bytes.Repeat([]byte{0, 255, 13, 10, 1}, 1<<18)
	server := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			server <- err
			return
		}
		defer conn.Close()
		data, err := io.ReadAll(conn)
		if err != nil {
			server <- err
			return
		}
		_, err = conn.Write(append([]byte("after-eof:"), data...))
		server <- err
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var output bytes.Buffer
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if err := relay(ctx, conn, bytes.NewReader(payload), &output); err != nil {
		t.Fatal(err)
	}
	if err := <-server; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), append([]byte("after-eof:"), payload...)) {
		t.Fatal("binary stream or half-close lost")
	}
}
