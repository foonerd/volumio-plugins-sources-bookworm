#!/bin/bash

echo "Cleaning up lcd1602-vumeter plugin..."

# Optional: remove Python packages if exclusively used by this plugin
pip3 uninstall RPLCD smbus2 pyalsaaudio numpy -y

exit 0
