# FM/DAB Radio Plugin for Volumio

Receive FM and DAB/DAB+ radio using RTL-SDR USB tuners.

## Hardware Requirements

- RTL-SDR USB dongle (RTL2832U chipset)
- Compatible with R820T, R820T2, E4000 tuners
- Antenna suitable for FM (88-108 MHz) and/or DAB Band III (174-240 MHz)

## Supported Platforms

- Raspberry Pi (armhf, arm64)
- x86/x64 systems (amd64)
- Volumio 4.x (Bookworm)

## Features

### Radio Reception
- FM radio reception (87.5-108 MHz)
- DAB and DAB+ digital radio
- Automatic station scanning with configurable sensitivity
- Integrated with Volumio's playback system
- Volume control through Volumio

### Station Management
- Web-based station management interface
- Mark stations as favorites
- Hide unwanted stations
- Custom station naming
- Search and filter stations
- Recycle bin for deleted stations (recoverable)
- Per-row save buttons for quick edits
- Bulk operations (clear all, rescan)

### Web Interface Access
The station management interface is accessible at:
- `http://<volumio-ip>:3456`
- Or via Volumio plugin settings (three access methods available)

## Installation

1. Install plugin through Volumio plugin store
2. **IMPORTANT: Restart Volumio** (`sudo systemctl restart volumio`)
3. Connect RTL-SDR USB dongle
4. Enable plugin in Volumio settings
5. Scan for available stations
6. Browse and play stations from "FM/DAB Radio" source

**Note:** You MUST restart Volumio after installation and before enabling the plugin. Enabling without restart will cause errors.

## Usage

### Playing Stations
1. Navigate to "Music Library" in Volumio
2. Select "FM/DAB Radio" source
3. Browse available stations
4. Click to play

### Managing Stations
1. Open plugin settings in Volumio
2. Click "Open Station Manager" (or access directly at port 3456)
3. Use the web interface to:
   - Mark favorites (star icon)
   - Hide stations (eye icon)
   - Delete stations (trash icon)
   - Rename stations (edit name field)
   - Search for stations
   - Rescan for new stations

### Save Options (v0.9.2)
Three ways to save changes:
- Click green save button on individual changed rows
- Click "Save (n)" button at top (saves all changes)
- Use save bar at bottom (saves all changes)

## Development

Prototype repository: https://github.com/foonerd/volumio-plugins-sources-bookworm
Target repository: https://github.com/volumio/volumio-plugins-sources-bookworm

## Architecture

- Uses ALSA loopback for lightweight audio routing
- Minimal CPU overhead (suitable for Pi Zero W2)
- Direct PCM passthrough (no encoding/decoding)
- Integrated with Volumio's music_service framework
- Web management interface on port 3456
- Station data stored in JSON format

## Troubleshooting

### Plugin won't enable
- Ensure Volumio was restarted after plugin installation
- Check RTL-SDR dongle is connected
- Verify dongle is detected: `lsusb | grep RTL`

### No stations found
- Check antenna is connected
- Try adjusting scan sensitivity in settings
- Ensure good signal reception (location dependent)

### Web interface not accessible
- Verify port 3456 is not blocked by firewall
- Check plugin is enabled
- Try accessing via hostname: `http://volumio.local:3456`

## License

GPL-3.0

## Author

Just a Nerd

## Version

Current: v0.9.2
- Defense-in-depth save strategy
- Per-row save buttons
- Improved user feedback
- CSS specificity fixes
