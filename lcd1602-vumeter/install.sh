#!/bin/bash

echo "Installing dependencies for lcd1602-vumeter..."

# System dependencies (if missing)
sudo apt-get update
sudo apt-get install -y python3-pip libasound2-dev i2c-tools

# Python dependencies
pip3 install RPLCD smbus2 pyalsaaudio numpy

echo "Installation complete."
exit 0
