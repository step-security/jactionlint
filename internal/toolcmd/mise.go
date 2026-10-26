// Package toolcmd resolves project-pinned executables before tools change directories.
package toolcmd

import (
	"fmt"
	"os/exec"
	"strings"
)

// Resolve returns an explicit command unchanged, or resolves tool through the
// current mise project configuration and returns its executable path.
func Resolve(explicit, tool string) ([]string, error) {
	return resolve(explicit, tool, exec.LookPath, func(mise string, args ...string) ([]byte, error) {
		return exec.Command(mise, args...).Output()
	})
}

func resolve(explicit, tool string, lookPath func(string) (string, error), run func(string, ...string) ([]byte, error)) ([]string, error) {
	if command := strings.Fields(explicit); len(command) > 0 {
		return command, nil
	}

	mise, err := lookPath("mise")
	if err != nil {
		return nil, fmt.Errorf("resolve pinned %s: mise is not available: %w", tool, err)
	}
	output, err := run(mise, "which", tool)
	if err != nil {
		return nil, fmt.Errorf("resolve pinned %s with mise which: %w", tool, err)
	}
	path := strings.TrimSpace(string(output))
	if path == "" {
		return nil, fmt.Errorf("resolve pinned %s with mise which: empty executable path", tool)
	}
	return []string{path}, nil
}
