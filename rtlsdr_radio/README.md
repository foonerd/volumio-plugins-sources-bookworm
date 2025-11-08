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

- FM radio reception (87.5-108 MHz)
- DAB and DAB+ digital radio
- Station scanning and management
- Integrated with Volumio's playback system
- Volume control through Volumio

## Installation

1. Install plugin through Volumio plugin store
2. **IMPORTANT: Restart Volumio** (`sudo systemctl restart volumio`)
3. Connect RTL-SDR USB dongle
4. Enable plugin in Volumio settings
5. Scan for available stations
6. Browse and play stations from "FM/DAB Radio" source

**Note:** You MUST restart Volumio after installation and before enabling the plugin. Enabling without restart will cause errors.

## Development

Prototype repository: https://github.com/foonerd/volumio-plugins-sources-bookworm
Target repository: https://github.com/volumio/volumio-plugins-sources-bookworm

## Architecture

- Uses ALSA loopback for lightweight audio routing
- Minimal CPU overhead (suitable for Pi Zero W2)
- Direct PCM passthrough (no encoding/decoding)
- Integrated with Volumio's music_service framework

## License

GPL-3.0

## Author

Just a Nerd
