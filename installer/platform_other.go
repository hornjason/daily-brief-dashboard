//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

func hiddenWindowAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{}
}

func isAdmin() bool {
	return os.Geteuid() == 0
}

func relaunchAsAdmin() {
	fmt.Println("This installer is for Windows only.")
	os.Exit(1)
}
