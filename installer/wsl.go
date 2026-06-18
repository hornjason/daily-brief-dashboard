package main

import (
	"os/exec"
	"strings"
)

func wslIsEnabled() bool {
	out, err := runSilent("wsl", "--status")
	if err != nil {
		return false
	}
	lower := strings.ToLower(out)
	return strings.Contains(lower, "default version") ||
		strings.Contains(lower, "wsl version")
}

func enableWSL() error {
	cmd := exec.Command("wsl", "--install", "--no-launch")
	cmd.SysProcAttr = hiddenWindowAttr()
	return cmd.Run()
}
