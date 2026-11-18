"""Initialize a CH340 when this host only has the generic USB serial driver.

Register definitions and the 1 Mbaud divisor follow Linux v6.1 ch341.c:
https://github.com/torvalds/linux/blob/v6.1/drivers/usb/serial/ch341.c
Native ch341 drivers and other USB devices are left to their own drivers.
"""
from pathlib import Path
import os


def initialize_generic_ch340(port):
    tty = Path(port).resolve().name
    device = Path("/sys/class/tty") / tty / "device"
    driver = device / "driver"
    if not driver.exists() or driver.resolve().name != "generic":
        return False
    usb = next((parent for parent in device.resolve().parents
                if (parent / "idVendor").is_file()), None)
    if usb is None or (usb / "idVendor").read_text().strip() != "1a86" or (usb / "idProduct").read_text().strip() != "7523":
        return False

    import ctypes
    import fcntl

    class Control(ctypes.Structure):
        _fields_ = [("request_type", ctypes.c_uint8), ("request", ctypes.c_uint8),
                    ("value", ctypes.c_uint16), ("index", ctypes.c_uint16),
                    ("length", ctypes.c_uint16), ("timeout", ctypes.c_uint32),
                    ("data", ctypes.c_void_p)]

    bus = int((usb / "busnum").read_text())
    number = int((usb / "devnum").read_text())
    fd = os.open(f"/dev/bus/usb/{bus:03d}/{number:03d}", os.O_RDWR)
    try:
        def transfer(direction, request, value=0, index=0, size=0):
            buffer = ctypes.create_string_buffer(size) if size else None
            control = Control(direction, request, value, index, size, 1000,
                              ctypes.addressof(buffer) if buffer is not None else 0)
            ioctl = 0xC0005500 | (ctypes.sizeof(Control) << 16)  # USBDEVFS_CONTROL
            fcntl.ioctl(fd, ioctl, bytes(control))
            return buffer.raw if buffer is not None else b""

        version = transfer(0xC0, 0x5F, size=2)[0]
        if version < 0x30:
            raise OSError(f"CH340 version {version:#x} needs a native ch341 driver")
        transfer(0x40, 0xA1)  # UART initialization
        transfer(0x40, 0x9A, 0x1312, 0xFA83)  # 1,000,000 baud, low-latency RX
        transfer(0x40, 0x9A, 0x2518, 0x00C3)  # RX/TX enabled, 8N1
        transfer(0x40, 0xA4, 0xFFFF)  # DTR/RTS deasserted, matching run_link
    finally:
        os.close(fd)
    return True
