package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/ncruces/zenity"
)

const (
	appName       = "DailyBriefDashboard"
	containerName = "daily-brief-dashboard"
	imageRef      = "ghcr.io/hornjason/daily-brief-dashboard:latest"
	dashboardURL  = "http://localhost:7777/dashboard/setup"
	hostPort      = "7777"
)

type InstallState struct {
	Phase     int    `json:"phase"`
	Timestamp string `json:"timestamp"`
}

func stateFilePath() string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Roaming")
	}
	return filepath.Join(appData, appName, "install-state.json")
}

func dataDir() string {
	home := os.Getenv("USERPROFILE")
	return filepath.Join(home, appName, "data")
}

func readState() InstallState {
	data, err := os.ReadFile(stateFilePath())
	if err != nil {
		return InstallState{Phase: 0}
	}
	var state InstallState
	if err := json.Unmarshal(data, &state); err != nil {
		return InstallState{Phase: 0}
	}
	return state
}

func writeState(state InstallState) error {
	state.Timestamp = time.Now().Format(time.RFC3339)
	dir := filepath.Dir(stateFilePath())
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(stateFilePath(), data, 0644)
}

func main() {
	if containerIsRunning() {
		openBrowser(dashboardURL)
		zenity.Info("Dashboard is already running!\n\nOpening in your browser...",
			zenity.Title(appName))
		return
	}

	if containerExists() {
		startExistingContainer()
		return
	}

	runInstaller()
}

func containerIsRunning() bool {
	out, err := runSilent("podman", "inspect", "--format", "{{.State.Running}}", containerName)
	return err == nil && out == "true"
}

func containerExists() bool {
	_, err := runSilent("podman", "inspect", containerName)
	return err == nil
}

func startExistingContainer() {
	dlg, err := zenity.Progress(
		zenity.Title(appName),
		zenity.MaxValue(100),
	)
	if err != nil {
		showError("Failed to create progress dialog", err)
		return
	}

	dlg.Text("Starting Podman machine...")
	dlg.Value(20)
	ensurePodmanMachineRunning()

	dlg.Text("Starting dashboard container...")
	dlg.Value(60)
	runSilent("podman", "start", containerName)

	dlg.Text("Waiting for dashboard to be ready...")
	dlg.Value(80)
	waitForDashboard()

	dlg.Text("Opening browser...")
	dlg.Value(100)
	openBrowser(dashboardURL)
	dlg.Complete()
	dlg.Close()
}

func runInstaller() {
	if !isAdmin() {
		relaunchAsAdmin()
		return
	}

	dlg, err := zenity.Progress(
		zenity.Title(appName+" Setup"),
		zenity.MaxValue(100),
	)
	if err != nil {
		showError("Failed to create progress dialog", err)
		return
	}

	state := readState()

	if state.Phase == 1 {
		dlg.Text("Welcome back! Continuing setup after restart...")
		dlg.Value(15)
	} else {
		dlg.Text("Checking system requirements...")
		dlg.Value(5)
	}

	if !wslIsEnabled() {
		dlg.Text("Enabling WSL2 (Windows Subsystem for Linux)...")
		dlg.Value(10)

		if err := enableWSL(); err != nil {
			dlg.Close()
			showError("Failed to enable WSL2", err)
			return
		}

		writeState(InstallState{Phase: 1})
		dlg.Close()

		zenity.Info(
			"Your computer needs to restart to finish setting up WSL2.\n\n"+
				"After it restarts, run this installer again —\n"+
				"it will pick up where it left off.",
			zenity.Title(appName+" Setup"),
		)
		return
	}

	dlg.Text("Checking for Podman...")
	dlg.Value(20)

	if !podmanIsInstalled() {
		dlg.Text("Installing Podman Desktop (this may take a few minutes)...")
		dlg.Value(25)

		if err := installPodman(); err != nil {
			dlg.Close()
			showError("Failed to install Podman", err)
			return
		}
		dlg.Value(40)
	}

	dlg.Text("Setting up Podman machine (first-time setup, may take a few minutes)...")
	dlg.Value(45)

	if err := initPodmanMachine(); err != nil {
		dlg.Close()
		showError("Failed to initialize Podman machine", err)
		return
	}
	dlg.Value(55)

	dlg.Text("Starting Podman machine...")
	dlg.Value(60)
	ensurePodmanMachineRunning()

	dlg.Text("Downloading dashboard (this may take a few minutes)...")
	dlg.Value(65)

	if err := pullImage(); err != nil {
		dlg.Close()
		showError("Failed to download dashboard image", err)
		return
	}
	dlg.Value(80)

	dlg.Text("Starting dashboard...")
	dlg.Value(85)

	if err := startContainer(); err != nil {
		dlg.Close()
		showError("Failed to start dashboard", err)
		return
	}

	dlg.Text("Waiting for dashboard to be ready...")
	dlg.Value(90)
	waitForDashboard()

	dlg.Text("Creating Start Menu shortcut...")
	dlg.Value(95)
	createShortcut()

	writeState(InstallState{Phase: 2})

	dlg.Text("Done! Opening your browser...")
	dlg.Value(100)
	openBrowser(dashboardURL)
	dlg.Complete()

	time.Sleep(time.Second)
	dlg.Close()

	zenity.Info(
		"Dashboard is installed and running!\n\n"+
			"Open it anytime from the Start Menu:\n"+
			"  → "+appName+"\n\n"+
			"Or visit: "+dashboardURL,
		zenity.Title(appName+" Setup Complete"),
	)
}

func showError(msg string, err error) {
	detail := msg
	if err != nil {
		detail = fmt.Sprintf("%s\n\nError: %s", msg, err.Error())
	}
	zenity.Error(detail, zenity.Title(appName+" — Error"))
}

func openBrowser(url string) {
	exec.Command("cmd", "/c", "start", "", url).Start()
}

func waitForDashboard() {
	for i := 0; i < 30; i++ {
		_, err := runSilent("curl", "-s", "-o", "nul", "-w", "%{http_code}",
			fmt.Sprintf("http://localhost:%s/api/aes", hostPort))
		if err == nil {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

func runSilent(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = hiddenWindowAttr()
	out, err := cmd.Output()
	return trimOutput(string(out)), err
}

func trimOutput(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func arch() string {
	if runtime.GOARCH == "arm64" {
		return "arm64"
	}
	return "amd64"
}
