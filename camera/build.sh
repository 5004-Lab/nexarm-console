#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
bundle=.camera/NexArmCamera.app/Contents
binary="$bundle/MacOS/NexArmCamera"
if [ -x "$binary" ] && [ "$binary" -nt camera/Capture.swift ] && [ "$binary" -nt camera/Info.plist ]; then
  exit 0
fi
mkdir -p "$bundle/MacOS"
cp camera/Info.plist "$bundle/Info.plist"
swiftc -O camera/Capture.swift -o "$binary"
codesign --force --sign - .camera/NexArmCamera.app
