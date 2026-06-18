//go:build windows

package main

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
)

func hiddenWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow: true,
	}
}

func isAdmin() bool {
	cmd := exec.Command("net", "session")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	err := cmd.Run()
	return err == nil
}

func relaunchAsAdmin() {
	exe, _ := os.Executable()
	args := strings.Join(os.Args[1:], " ")

	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		"Start-Process", "-Verb", "RunAs", "-FilePath", "'"+exe+"'")
	if args != "" {
		cmd = exec.Command("powershell", "-NoProfile", "-Command",
			"Start-Process", "-Verb", "RunAs", "-FilePath", "'"+exe+"'",
			"-ArgumentList", "'"+args+"'")
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Run()
}
