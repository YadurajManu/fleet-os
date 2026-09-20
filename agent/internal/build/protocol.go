// Package build implements version 1 delegated build messages. Identity is
// always (job_id, attempt); retries must never consume an earlier result.
package build

type Source struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}
type Assignment struct {
	Type             string            `json:"type"`
	Version          int               `json:"version"`
	JobID            string            `json:"job_id"`
	Attempt          int               `json:"attempt"`
	Platform         string            `json:"platform"`
	Source           Source            `json:"source"`
	Dockerfile       string            `json:"dockerfile"`
	BuildArgs        map[string]string `json:"build_args,omitempty"`
	Secrets          map[string]string `json:"secrets,omitempty"`
	RegistryTarget   string            `json:"registry_target"`
	RegistryUsername string            `json:"registry_username"`
	RegistryPassword string            `json:"registry_password"`
	TimeoutMs        int64             `json:"timeout_ms"`
	CPU              int               `json:"cpu"`
	MemoryBytes      int64             `json:"memory_bytes"`
	DiskBytes        int64             `json:"disk_bytes"`
}
type Event struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	JobID   string `json:"job_id"`
	Attempt int    `json:"attempt"`
	Status  string `json:"status,omitempty"`
	Digest  string `json:"digest,omitempty"`
	Error   string `json:"error,omitempty"`
	Text    string `json:"text,omitempty"`
}
