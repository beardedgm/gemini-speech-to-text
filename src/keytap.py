#!/usr/bin/env python3
"""Tiny virtual keyboard for flowcode (stdlib only).

Creates a uinput device once, then taps keys on request. Each line on stdin
is a Linux key code to tap (press + release); "quit" exits. Prints "ready"
once the device exists.

flowcode uses it to tap KEY_F24 (bound to nothing) while Super is held, so
COSMIC sees the Super press as part of a chord and doesn't open the Launcher
when Super is released.
"""
import fcntl
import os
import struct
import sys
import time

UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_DEV_SETUP = 0x405C5503
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
EV_SYN, EV_KEY, SYN_REPORT = 0, 1, 0
BUS_VIRTUAL = 0x06
KEYS = [194]  # KEY_F24


def emit(fd, etype, code, value):
    os.write(fd, struct.pack("llHHi", 0, 0, etype, code, value))


def main():
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for k in KEYS:
        fcntl.ioctl(fd, UI_SET_KEYBIT, k)
    name = b"flowcode virtual keys"
    setup = struct.pack("HHHH80sI", BUS_VIRTUAL, 0x1234, 0x5678, 1, name, 0)
    fcntl.ioctl(fd, UI_DEV_SETUP, setup)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(0.3)  # give the compositor time to open the new device
    print("ready", flush=True)
    try:
        for line in sys.stdin:
            line = line.strip()
            if line == "quit":
                break
            if not line.isdigit() or int(line) not in KEYS:
                continue
            code = int(line)
            emit(fd, EV_KEY, code, 1)
            emit(fd, EV_SYN, SYN_REPORT, 0)
            emit(fd, EV_KEY, code, 0)
            emit(fd, EV_SYN, SYN_REPORT, 0)
    finally:
        fcntl.ioctl(fd, UI_DEV_DESTROY)
        os.close(fd)


if __name__ == "__main__":
    main()
