#!/bin/bash

echo "Installing FM/DAB Radio plugin dependencies"

# Detect architecture
ARCH=$(dpkg --print-architecture)
PLUGIN_DIR="/data/plugins/music_service/rtlsdr_radio"
BIN_SOURCE="$PLUGIN_DIR/bin/$ARCH"

echo "Detected architecture: $ARCH"

# Verify architecture is supported
if [ ! -d "$BIN_SOURCE" ]; then
  echo "ERROR: Architecture $ARCH not supported"
  echo "Supported: armhf, arm64, amd64"
  exit 1
fi

# Update package list
apt-get update

# Install RTL-SDR libraries (lightweight, no compilation)
echo "Installing RTL-SDR libraries..."
apt-get install -y rtl-sdr librtlsdr0

# Install runtime dependencies for DAB (no build tools)
echo "Installing DAB runtime dependencies..."
apt-get install -y libfftw3-3 libsamplerate0 libfaad2

# Copy pre-compiled binaries
echo "Installing DAB binaries..."
cp "$BIN_SOURCE/dab-rtlsdr-3" /usr/local/bin/
cp "$BIN_SOURCE/dab-scanner-3" /usr/local/bin/
chmod +x /usr/local/bin/dab-rtlsdr-3
chmod +x /usr/local/bin/dab-scanner-3

# Verify installation
if [ ! -f /usr/local/bin/dab-rtlsdr-3 ]; then
  echo "ERROR: dab-rtlsdr-3 installation failed"
  exit 1
fi

# Create sudoers entry for process control
echo "Creating sudoers entry for rtlsdr_radio..."
cat > /etc/sudoers.d/volumio-user-rtlsdr-radio << EOF
# rtlsdr_radio plugin - process control
volumio ALL=(ALL) NOPASSWD: /usr/bin/pkill
EOF

chmod 0440 /etc/sudoers.d/volumio-user-rtlsdr-radio

visudo -c -f /etc/sudoers.d/volumio-user-rtlsdr-radio
if [ $? -ne 0 ]; then
  echo "ERROR: Invalid sudoers syntax"
  rm -f /etc/sudoers.d/volumio-user-rtlsdr-radio
  exit 1
fi

# Load ALSA loopback module
echo "Loading ALSA loopback module..."
modprobe snd-aloop

# Make ALSA loopback persistent
if ! grep -q "snd-aloop" /etc/modules; then
  echo "snd-aloop" >> /etc/modules
  echo "Made snd-aloop module persistent"
fi

# Create stations database directory
mkdir -p /data/plugins/music_service/rtlsdr_radio

echo "FM/DAB Radio plugin installation complete"
echo "Installation time: ~30 seconds (vs 20+ minutes for compilation)"
