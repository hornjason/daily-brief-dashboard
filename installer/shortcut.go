package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func createShortcut() {
	startMenu := filepath.Join(os.Getenv("APPDATA"),
		"Microsoft", "Windows", "Start Menu", "Programs")
	shortcutPath := filepath.Join(startMenu, appName+".lnk")

	exePath, err := os.Executable()
	if err != nil {
		return
	}

	// Use PowerShell to create the .lnk shortcut — avoids COM interop complexity
	ps := `$ws = New-Object -ComObject WScript.Shell; ` +
		`$sc = $ws.CreateShortcut('` + shortcutPath + `'); ` +
		`$sc.TargetPath = '` + exePath + `'; ` +
		`$sc.Description = 'Launch DailyBriefDashboard'; ` +
		`$sc.Save()`

	cmd := exec.Command("powershell", "-NoProfile", "-Command", ps)
	cmd.SysProcAttr = hiddenWindowAttr()
	cmd.Run()
}
