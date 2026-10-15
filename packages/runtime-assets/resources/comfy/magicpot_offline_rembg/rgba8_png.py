"""Small RGBA8-only PNG writer. No metadata, PIL or generic output path API."""
from dataclasses import dataclass
import os
from pathlib import Path
import re
import secrets
import struct
import zlib

from .offline_loader import (
    MAX_DIMENSION, MAX_PIXELS, OfflineError, _directory_chain, _fail, _identity,
    _regular_single_file, require_owned_launch_policy,
)

MAX_ENCODED_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class Rgba8:
    width: int
    height: int
    pixels: bytes


def validate_rgba8(image):
    if type(image) is not Rgba8:
        _fail('INVALID_RGBA8')
    if type(image.width) is not int or type(image.height) is not int:
        _fail('INVALID_RGBA8')
    if (not 0 < image.width <= MAX_DIMENSION or not 0 < image.height <= MAX_DIMENSION or
            image.width * image.height > MAX_PIXELS):
        _fail('INVALID_RGBA8')
    if type(image.pixels) is not bytes or len(image.pixels) != image.width * image.height * 4:
        _fail('INVALID_RGBA8')
    alpha = image.pixels[3::4]
    if not any(alpha) or all(value == 255 for value in alpha):
        _fail('INVALID_RGBA8')


def _chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


def encode_rgba8(image):
    """Return bounded PNG bytes: 8-bit color type 6, noninterlaced, filter 0."""
    validate_rgba8(image)
    try:
        compressor = zlib.compressobj()
        compressed = bytearray()
        stride = image.width * 4
        for start in range(0, len(image.pixels), stride):
            compressed.extend(compressor.compress(b'\0' + image.pixels[start:start + stride]))
            if len(compressed) + 57 > MAX_ENCODED_BYTES:
                _fail('PNG_TOO_LARGE')
        compressed.extend(compressor.flush())
        if len(compressed) + 57 > MAX_ENCODED_BYTES:
            _fail('PNG_TOO_LARGE')
        header = struct.pack('>IIBBBBB', image.width, image.height, 8, 6, 0, 0, 0)
        return b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', header) + _chunk(b'IDAT', bytes(compressed)) + _chunk(b'IEND', b'')
    except OfflineError:
        raise
    except Exception:
        _fail('PNG_ENCODING_FAILED')


def _cleanup_owned_file(path, created):
    # Best-effort only. Never delete a pre-existing collision or a replacement.
    # Ordinary local filesystems; not a hostile concurrent namespace guarantee.
    if path is None or created is None:
        return
    try:
        _directory_chain(path.parent)
        current = os.lstat(path)
        _regular_single_file(current)
        if _identity(current) == _identity(created):
            os.unlink(path)
    except OSError:
        pass
    except ValueError:
        pass


def save_owned_rgba8(image):
    """One random exclusive file in the launcher's existing owned output root.

    No caller filename/prefix/path, overwrite, retries or managed publication.
    The future backend must bind the exact output file, not just this locator.
    """
    policy = require_owned_launch_policy()
    encoded = encode_rgba8(image)
    fd, path, created = None, None, None
    try:
        root = Path(policy.owned_output_root)
        before = _directory_chain(root)
        token = secrets.token_hex(16)
        if type(token) is not str or not re.fullmatch(r'[0-9a-f]{32}', token):
            raise ValueError()
        filename = 'magicpot-rgba8-' + token + '.png'
        path = root / filename
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(path, flags, 0o600)
        created = os.fstat(fd)
        _regular_single_file(created)
        handle = os.fdopen(fd, 'wb')
        fd = None
        with handle:
            if _identity(before) != _identity(_directory_chain(root)):
                raise ValueError()
            if handle.write(encoded) != len(encoded):
                raise ValueError()
            handle.flush()
            os.fsync(handle.fileno())
            after = os.fstat(handle.fileno())
            named = os.lstat(path)
            _regular_single_file(after)
            _regular_single_file(named)
            if (_identity(created) != _identity(after) or _identity(after) != _identity(named) or
                    after.st_size != len(encoded) or named.st_size != len(encoded) or
                    _identity(before) != _identity(_directory_chain(root))):
                raise ValueError()
        return {'filename': filename, 'subfolder': '', 'type': 'output'}
    except Exception:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
            fd = None
        _cleanup_owned_file(path, created)
        _fail('OUTPUT_REJECTED')
