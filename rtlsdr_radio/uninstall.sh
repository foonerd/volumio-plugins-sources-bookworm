#!/bin/bash

echo "Uninstalling FM/DAB Radio plugin"

# Stop any running decoder processes
pkill -f rtl_fm
pkill -f dab-rtlsdr

# Remove sudoers entry
if [ -f /etc/sudoers.d/volumio-user-rtlsdr-radio ]; then
  rm -f /etc/sudoers.d/volumio-user-rtlsdr-radio
  echo "Removed sudoers entry"
fi

# Remove ALSA loopback from persistent modules
sed -i '/snd-aloop/d' /etc/modules

# Unload ALSA loopback module
rmmod snd-aloop 2>/dev/null

echo "FM/DAB Radio plugin uninstalled"
echo "Note: RTL-SDR libraries and dab-cmdline were NOT removed"
echo "To remove them manually, run:"
echo "  apt-get remove rtl-sdr librtlsdr-dev"
