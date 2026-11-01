#!/usr/bin/env python3
"""Add classes.dex to the linked resource APK and 4-byte align the result.

This exists because Termux has no zipalign. It is not packaged, and a search
of the whole termux-packages tree returns nothing, so the usual
`zip -u` + `zipalign` tail of an Android build cannot run on a phone.

Alignment is not cosmetic. Android maps uncompressed entries straight out of
the APK, so resources.arsc and classes.dex have to begin on a 4-byte
boundary; since Android 11 the installer refuses a package whose
resources.arsc is compressed or misaligned. Appending to the archive with
`zip` is what destroys that alignment, which is why this script does the
appending itself rather than fixing it up afterwards.

Entry payloads are copied byte for byte out of the input - never recompressed
- so the CRC and contents aapt2 produced survive untouched.

    python3 pack.py base.apk classes.dex out.apk
"""

from __future__ import annotations

import binascii
import struct
import sys
import zipfile

ALIGNMENT = 4

# Entries Android maps in place and therefore cannot read compressed. Since
# Android 11 the installer rejects a package whose resources.arsc is
# deflated, and not every aapt2 build accepts the -0 flag that would have
# stored it at link time, so it is re-stored here instead of being asked for.
FORCE_STORED = ("resources.arsc",)

LOCAL_SIG = 0x04034B50
CENTRAL_SIG = 0x02014B50
EOCD_SIG = 0x06054B50

LOCAL_FMT = "<IHHHHHIIIHH"      # 30 bytes
CENTRAL_FMT = "<IHHHHHHIIIHHHHHII"  # 46 bytes
EOCD_FMT = "<IHHHHIIH"          # 22 bytes


class Entry:
    """One member of the archive, carrying its payload exactly as stored."""

    def __init__(self, name, data, crc, csize, usize, method, flags,
                 date_time, extra, create_system, internal_attr, external_attr):
        self.name = name
        self.data = data
        self.crc = crc
        self.csize = csize
        self.usize = usize
        self.method = method
        self.flags = flags
        self.date_time = date_time
        self.extra = extra
        self.create_system = create_system
        self.internal_attr = internal_attr
        self.external_attr = external_attr


def _dos_time(date_time):
    y, mo, d, h, mi, s = date_time
    if y < 1980:
        y, mo, d, h, mi, s = 1980, 1, 1, 0, 0, 0
    return ((h << 11) | (mi << 5) | (s // 2),
            (((y - 1980) & 0x7F) << 9) | (mo << 5) | d)


def read_entries(path):
    """Pull every member out of an archive with its payload still compressed."""
    out = []
    with zipfile.ZipFile(path, "r") as z, open(path, "rb") as raw:
        for info in z.infolist():
            raw.seek(info.header_offset)
            head = raw.read(30)
            sig, _ver, _flags, _method, _t, _d, _crc, _cs, _us, nlen, elen = \
                struct.unpack(LOCAL_FMT, head)
            if sig != LOCAL_SIG:
                raise ValueError("bad local header for %s in %s" % (info.filename, path))
            raw.seek(info.header_offset + 30 + nlen + elen)
            # The central directory is authoritative: a local header may carry
            # zeroes and defer the real sizes to a trailing data descriptor.
            payload = raw.read(info.compress_size)
            if len(payload) != info.compress_size:
                raise ValueError("truncated payload for %s" % info.filename)

            method = info.compress_type
            csize = info.compress_size
            if info.filename in FORCE_STORED and method != zipfile.ZIP_STORED:
                # The CRC in a zip is of the uncompressed bytes either way,
                # so it carries over untouched.
                payload = z.read(info.filename)
                method = zipfile.ZIP_STORED
                csize = len(payload)

            out.append(Entry(
                name=info.filename,
                data=payload,
                crc=info.CRC,
                csize=csize,
                usize=info.file_size,
                method=method,
                # Bit 3 says "sizes follow in a data descriptor". We write the
                # sizes into the header, so the claim must be withdrawn.
                flags=info.flag_bits & ~0x08,
                date_time=info.date_time,
                extra=info.extra,
                create_system=info.create_system,
                internal_attr=info.internal_attr,
                external_attr=info.external_attr,
            ))
    return out


def write_aligned(path, entries, alignment=ALIGNMENT):
    """Write the archive, padding so stored payloads start on a boundary."""
    with open(path, "wb") as fh:
        central = []
        for e in entries:
            name = e.name.encode("utf-8")
            extra = bytes(e.extra or b"")
            offset = fh.tell()

            if e.method == zipfile.ZIP_STORED:
                # Only uncompressed entries are mapped in place, so only they
                # need aligning. Padding goes in the extra field, which is
                # what zipalign itself does.
                overshoot = (offset + 30 + len(name) + len(extra)) % alignment
                if overshoot:
                    extra = extra + b"\0" * (alignment - overshoot)

            dostime, dosdate = _dos_time(e.date_time)
            fh.write(struct.pack(
                LOCAL_FMT, LOCAL_SIG, 20, e.flags, e.method, dostime, dosdate,
                e.crc, e.csize, e.usize, len(name), len(extra)))
            fh.write(name)
            fh.write(extra)
            fh.write(e.data)
            central.append((e, offset, name, extra))

        cd_start = fh.tell()
        for e, offset, name, _local_extra in central:
            dostime, dosdate = _dos_time(e.date_time)
            # The central directory keeps the original extra field; only the
            # local one was padded, and the two are allowed to differ.
            cd_extra = bytes(e.extra or b"")
            fh.write(struct.pack(
                CENTRAL_FMT, CENTRAL_SIG, (e.create_system << 8) | 20, 20,
                e.flags, e.method, dostime, dosdate, e.crc, e.csize, e.usize,
                len(name), len(cd_extra), 0, 0, e.internal_attr,
                e.external_attr, offset))
            fh.write(name)
            fh.write(cd_extra)
        cd_size = fh.tell() - cd_start

        fh.write(struct.pack(EOCD_FMT, EOCD_SIG, 0, 0, len(central),
                             len(central), cd_size, cd_start, 0))


def check(path, alignment=ALIGNMENT):
    """Fail loudly here rather than on the phone at install time."""
    with zipfile.ZipFile(path, "r") as z:
        broken = z.testzip()
        if broken:
            raise SystemExit("pack.py: corrupt entry %s" % broken)
        for name in FORCE_STORED:
            if name in z.namelist() and z.getinfo(name).compress_type != zipfile.ZIP_STORED:
                raise SystemExit("pack.py: %s is still compressed" % name)
        with open(path, "rb") as raw:
            for info in z.infolist():
                if info.compress_type != zipfile.ZIP_STORED:
                    continue
                raw.seek(info.header_offset)
                _s, _v, _f, _m, _t, _d, _c, _cs, _us, nlen, elen = \
                    struct.unpack(LOCAL_FMT, raw.read(30))
                start = info.header_offset + 30 + nlen + elen
                if start % alignment:
                    raise SystemExit(
                        "pack.py: %s starts at %d, not %d-aligned"
                        % (info.filename, start, alignment))


def main(argv):
    if len(argv) < 4:
        raise SystemExit(__doc__)
    base, out = argv[1], argv[-1]
    additions = argv[2:-1]

    entries = read_entries(base)
    have = set(e.name for e in entries)

    for path in additions:
        name = path.rsplit("/", 1)[-1]
        if name in have:
            raise SystemExit("pack.py: %s is already in %s" % (name, base))
        with open(path, "rb") as fh:
            blob = fh.read()
        # Stored, not deflated: the runtime reads dex straight from the APK
        # when it can, and a compressed one costs an extraction on install.
        entries.append(Entry(
            name=name, data=blob, crc=binascii.crc32(blob) & 0xFFFFFFFF,
            csize=len(blob), usize=len(blob), method=zipfile.ZIP_STORED,
            flags=0, date_time=(1980, 1, 1, 0, 0, 0), extra=b"",
            create_system=0, internal_attr=0, external_attr=0o644 << 16))

    write_aligned(out, entries)
    check(out)
    print("pack.py: %s - %d entries, %d-byte aligned"
          % (out, len(entries), ALIGNMENT))


if __name__ == "__main__":
    main(sys.argv)
