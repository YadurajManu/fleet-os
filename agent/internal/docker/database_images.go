package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"

	"github.com/fleet-os/fleet-os/agent/internal/capability"
)

type DatabaseImage struct {
	Reference     string `json:"reference"`
	Platform      string `json:"platform"`
	RequiredBytes int64  `json:"required_bytes"`
}

var databaseImageReference = regexp.MustCompile(`^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$`)

// PrepullDatabaseImages reuses the Engine pull path but refuses mutable images and unknown disk budgets.
func (c *Client) PrepullDatabaseImages(ctx context.Context, images []DatabaseImage, auth string, budget capability.DiskBudget, progress func(PullProgress)) error {
	if len(images) > 8 || budget.Free < 0 || budget.Reserve < 0 || budget.Free < budget.Reserve {
		return fmt.Errorf("database image disk budget is unavailable; refresh node capacity before retrying")
	}
	for _, image := range images {
		if !databaseImageReference.MatchString(image.Reference) || (image.Platform != "linux/arm64" && image.Platform != "linux/amd64") || image.RequiredBytes < 64<<20 || image.RequiredBytes > 8<<30 {
			return fmt.Errorf("invalid database image catalog entry; refresh the verified catalog before retrying")
		}
	}
	remaining := budget.Free - budget.Reserve
	for _, image := range images {
		var cached struct {
			OS           string `json:"Os"`
			Architecture string `json:"Architecture"`
		}
		err := c.do(ctx, http.MethodGet, "/"+c.api(ctx)+"/images/"+url.PathEscape(image.Reference)+"/json", nil, &cached)
		if err == nil && cached.OS+"/"+cached.Architecture == image.Platform {
			continue
		}
		if err != nil {
			var engineError *Error
			if !asError(err, &engineError) || engineError.StatusCode != http.StatusNotFound {
				return fmt.Errorf("cannot inspect cached database image; check Docker availability and retry")
			}
		}
		if remaining < image.RequiredBytes {
			return fmt.Errorf("insufficient Docker disk headroom for database images; free space or choose another node")
		}
		if err := c.PullForPlatform(ctx, image.Reference, auth, image.Platform, progress); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("database image pre-pull failed; check registry access and retry")
		}
		remaining -= image.RequiredBytes
	}
	return nil
}
