# Build resources

electron-builder reads platform assets from this directory (configured as
`directories.buildResources: build` in `electron-builder.yml`).

## App icons (optional but recommended)

Until you add icons, electron-builder falls back to the default Electron icon
and prints a warning — builds still succeed. To brand the app, drop these files
here (electron-builder auto-detects them by name):

| File         | Platform | Notes                                  |
| ------------ | -------- | -------------------------------------- |
| `icon.icns`  | macOS    | 512×512 (1024 for retina) icon set     |
| `icon.ico`   | Windows  | multi-resolution (256, 128, 64, 32, 16)|
| `icon.png`   | Linux    | 512×512 (min 256×256)                  |

A quick way to generate all three from a single 1024×1024 PNG:

```bash
npx electron-icon-builder --input=./icon-source.png --output=./build --flatten
```

## Other resources you may add later

- `entitlements.mac.plist` — for macOS hardened-runtime / notarization.
- `installer.nsh` — custom NSIS installer script for Windows.
