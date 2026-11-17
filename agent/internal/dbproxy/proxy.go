// Package dbproxy carries one database connection over a Docker exec stream.
package dbproxy

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"time"
)

// Run only reaches the engine in this container, never arbitrary network targets.
func Run(ctx context.Context, port int, input io.Reader, output io.Writer) error {
	if port != 5432 && port != 6432 && port != 6379 {
		return errors.New("unsupported database port")
	}
	conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return errors.New("database connection unavailable")
	}
	return relay(ctx, conn, input, output)
}

func relay(ctx context.Context, conn net.Conn, input io.Reader, output io.Writer) error {
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	written := make(chan error, 1)
	go func() {
		_, err := io.Copy(conn, input)
		if half, ok := conn.(interface{ CloseWrite() error }); ok {
			_ = half.CloseWrite()
		}
		if err != nil {
			_ = conn.Close()
		}
		written <- err
	}()
	_, err := io.Copy(output, conn)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return errors.New("database stream interrupted")
	}
	// The caller owns input and closes it when this function returns.
	select {
	case err = <-written:
		if err != nil {
			return errors.New("database input interrupted")
		}
	default:
	}
	return nil
}
