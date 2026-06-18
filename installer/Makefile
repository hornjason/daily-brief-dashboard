APP_NAME := DailyBriefDashboard-Setup
VERSION := 1.0.0

.PHONY: all clean windows-amd64 windows-arm64

all: windows-amd64 windows-arm64

windows-amd64:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/$(APP_NAME)-x64.exe .

windows-arm64:
	GOOS=windows GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/$(APP_NAME)-arm64.exe .

clean:
	rm -rf dist/
