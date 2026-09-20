//go:build !windows

package upgrade

func installForPlatform(staged, self string) (bool, error) { return installStagedInto(staged, self) }
func RunHelper(args []string) (bool, error)                { return false, nil }
