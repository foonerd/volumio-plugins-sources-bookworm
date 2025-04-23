# LCD1602 VU Meter Plugin for Volumio

This plugin displays real-time stereo volume levels on a 1602 I2C LCD screen using bar graphs. It reads system audio levels from ALSA and visualizes left/right channels on the LCD.

## Requirements

- Volumio running on Raspberry Pi
- LCD1602 display with I2C backpack (e.g. PCF8574)
- I2C enabled on Raspberry Pi (`sudo raspi-config`)
- Python 3 installed

## Installation

### 1. Clone the Plugin

```bash
cd /data/plugins/system_controller
git clone https://github.com/foonerd/volumio-plugins-sources-bookworm.git
cd volumio-plugins-sources-bookworm/lcd1602-vumeter
```

### 2. Run the Install Script

```bash
./install.sh
```

This installs required Python libraries and system packages.

### 3. Enable the Plugin in Volumio

- Open the Volumio web interface
- Go to Settings > Plugins > Installed Plugins
- Enable "LCD1602 VU Meter"
- Configure settings like I2C address and refresh rate

## Uninstallation

To remove the plugin:

```bash
./uninstall.sh
rm -rf /data/plugins/system_controller/lcd1602-vumeter
```

## Features

- Stereo bar graph visualization on LCD1602
- Adjustable refresh rate
- Configurable I2C address
- Modular character style (custom_chars.py)
- Volumio plugin UI configuration

## File Structure

```
lcd1602-vumeter/
├── index.js
├── package.json
├── install.sh
├── uninstall.sh
├── README.md
├── UIConfig.json
├── i18n/
│   └── strings_en.json
└── lcd/
    ├── display.py
    └── custom_chars.py
```

## Future Enhancements

- Vertical mode support
- MPD-based volume level fallback
- Peak-hold display mode
- Support for other LCD sizes

## Maintainer

Just a Nerd
