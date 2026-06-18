package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func podmanIsInstalled() bool {
	_, err := exec.LookPath("podman")
	return err == nil
}

func installPodman() error {
	_, err := exec.LookPath("winget")
	if err != nil {
		return installPodmanDirect()
	}
	return installPodmanViaWinget()
}

func installPodmanViaWinget() error {
	cmd := exec.Command("winget", "install",
		"--id", "RedHat.Podman-Desktop",
		"--silent",
		"--accept-source-agreements",
		"--accept-package-agreements",
	)
	cmd.SysProcAttr = hiddenWindowAttr()
	return cmd.Run()
}

func installPodmanDirect() error {
	msiURL := "https://github.com/containers/podman-desktop/releases/latest/download/podman-desktop-setup.exe"
	tempDir := os.TempDir()
	installerPath := filepath.Join(tempDir, "podman-desktop-setup.exe")

	cmd := exec.Command("curl", "-L", "-o", installerPath, msiURL)
	cmd.SysProcAttr = hiddenWindowAttr()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to download Podman Desktop: %w", err)
	}

	cmd = exec.Command(installerPath, "/S")
	cmd.SysProcAttr = hiddenWindowAttr()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to install Podman Desktop: %w", err)
	}

	os.Remove(installerPath)
	return nil
}

func podmanMachineExists() bool {
	out, err := runSilent("podman", "machine", "list", "--format", "{{.Name}}")
	return err == nil && strings.TrimSpace(out) != ""
}

func podmanMachineIsRunning() bool {
	out, err := runSilent("podman", "machine", "list", "--format", "{{.Running}}")
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(out), "true")
}

func initPodmanMachine() error {
	if podmanMachineExists() {
		return nil
	}
	cmd := exec.Command("podman", "machine", "init",
		"--cpus", "4",
		"--memory", "4096",
	)
	cmd.SysProcAttr = hiddenWindowAttr()
	return cmd.Run()
}

func ensurePodmanMachineRunning() {
	if podmanMachineIsRunning() {
		return
	}
	cmd := exec.Command("podman", "machine", "start")
	cmd.SysProcAttr = hiddenWindowAttr()
	cmd.Run()
}

func pullImage() error {
	cmd := exec.Command("podman", "pull", imageRef)
	cmd.SysProcAttr = hiddenWindowAttr()
	return cmd.Run()
}

func startContainer() error {
	dd := dataDir()
	os.MkdirAll(filepath.Join(dd, "config"), 0755)
	os.MkdirAll(filepath.Join(dd, "cache"), 0755)

	cmd := exec.Command("podman", "run",
		"-d",
		"--name", containerName,
		"-p", hostPort+":7777",
		"-v", dd+":/data",
		"-e", "PORT=7777",
		"-e", "CONFIG_DIR=/data/config",
		"-e", "CACHE_DIR=/data/cache",
		imageRef,
	)
	cmd.SysProcAttr = hiddenWindowAttr()
	return cmd.Run()
}
