package capability

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Keep plugin discovery while isolating credentials. Desktop commonly installs
// Buildx under the operator's config directory, not in a global CLI directory.
func DockerPluginDirs() []string {
	home, _ := os.UserHomeDir()
	base := os.Getenv("DOCKER_CONFIG")
	if base == "" {
		base = filepath.Join(home, ".docker")
	}
	return []string{filepath.Join(base, "cli-plugins"), "/Applications/Docker.app/Contents/Resources/cli-plugins", `C:\Program Files\Docker\Docker\resources\cli-plugins`}
}
func IsolatedDockerEnv(ctx context.Context, configDir string) ([]string, error) {
	endpoint := os.Getenv("DOCKER_HOST")
	if endpoint == "" || os.Getenv("DOCKER_CONTEXT") != "" {
		out, err := DockerCommand(ctx, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
		if err != nil {
			return nil, fmt.Errorf("cannot resolve Docker engine endpoint: %w", err)
		}
		endpoint = strings.TrimSpace(string(out))
	}
	if endpoint == "" {
		return nil, fmt.Errorf("Docker engine endpoint is empty")
	}
	env := []string{}
	for _, value := range os.Environ() {
		if strings.HasPrefix(value, "DOCKER_CONFIG=") || strings.HasPrefix(value, "DOCKER_CONTEXT=") || strings.HasPrefix(value, "DOCKER_HOST=") {
			continue
		}
		env = append(env, value)
	}
	return append(env, "DOCKER_CONFIG="+configDir, "DOCKER_HOST="+endpoint), nil
}
