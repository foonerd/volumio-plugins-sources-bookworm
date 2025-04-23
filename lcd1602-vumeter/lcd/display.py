import time
import alsaaudio
import numpy as np
from RPLCD.i2c import CharLCD
from RPLCD import cleared

# === LCD Setup ===
lcd = CharLCD('PCF8574', 0x27, cols=16, rows=2, charmap='A02')

# === Custom characters ===
from custom_chars import BAR_CHARS

for i, char in enumerate(BAR_CHARS):
    lcd.create_char(i, char)

# === Audio Mixer Access ===
try:
    mixer = alsaaudio.Mixer()  # default soundcard
except alsaaudio.ALSAAudioError:
    mixer = None

def get_stereo_volume():
    try:
        volumes = mixer.getvolume()
        if len(volumes) >= 2:
            return volumes[0], volumes[1]
        return volumes[0], volumes[0]
    except:
        return 0, 0

def volume_to_bar(vol):
    return int(np.interp(vol, [0, 100], [0, 7]))

# === Main Loop ===
try:
    with cleared(lcd):
        lcd.write_string("LCD1602 VU Meter")
    time.sleep(1)

    while True:
        left, right = get_stereo_volume()
        lbar = volume_to_bar(left)
        rbar = volume_to_bar(right)

        lcd.cursor_pos = (0, 0)
        lcd.write_string(' ' * 16)

        for i in range(8):
            lcd.cursor_pos = (0, i)
            lcd.write_string(chr(lbar if i < lbar else 0))
        for i in range(8):
            lcd.cursor_pos = (0, 8 + i)
            lcd.write_string(chr(rbar if i < rbar else 0))

        time.sleep(0.1)

except KeyboardInterrupt:
    lcd.clear()
    print("Shutdown signal received.")
