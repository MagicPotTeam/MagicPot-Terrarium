"""Explicit owned-launch policy; stdlib inspection is not runtime attestation."""
from dataclasses import dataclass
import hashlib
import io
import os
from pathlib import Path
import re
import stat

MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024
MAX_DIMENSION = 4096
MAX_PIXELS = 4194304


class OfflineError(RuntimeError):
    """Public failures contain only stable codes, never underlying path text."""


@dataclass(frozen=True, slots=True)
class OwnedLaunchPolicy:
    managed_checkpoint_root: str
    checkpoint_filename: str
    checkpoint_bytes: int
    checkpoint_sha256: str
    device: str
    owned_output_root: str


@dataclass(frozen=True, slots=True)
class FileVerification:
    file_verified: bool
    byte_count: int
    sha256: str


_policy = None


def _fail(code):
    global _policy
    _policy = None
    raise OfflineError(code) from None


def disable_owned_launch_policy():
    """Trusted launcher teardown. There is no environment/JSON policy loader."""
    global _policy
    _policy = None


def _absolute_path(value):
    if type(value) is not str or not value or '\x00' in value:
        raise ValueError()
    if not os.path.isabs(value):
        raise ValueError()
    parts = value.replace('\\', '/').split('/')
    if any(part in ('.', '..') for part in parts):
        raise ValueError()
    if os.name == 'nt':
        drive, rest = os.path.splitdrive(value)
        if not re.fullmatch(r'[A-Za-z]:', drive) or ':' in rest:
            raise ValueError()
        for part in parts[1:]:
            if part and (part.endswith((' ', '.')) or re.search(r'[<>"|?*]', part)):
                raise ValueError()
            stem = part.split('.')[0].upper()
            if stem in {'CON', 'PRN', 'AUX', 'NUL'} or re.fullmatch(r'(COM|LPT)[0-9]', stem):
                raise ValueError()
    return os.path.normcase(os.path.normpath(value))


def install_trusted_owned_launch_policy(policy):
    """Only an owned launcher calls this, before execution; no workflow inputs.

    Validate an exact frozen record without touching files or importing models.
    A failed install disables any previously installed policy. The launcher owns
    this process and must serialize installation/teardown with node executions.
    This is not an authorization boundary against other Python in the process.
    """
    global _policy
    _policy = None
    try:
        if type(policy) is not OwnedLaunchPolicy:
            raise ValueError()
        root = _absolute_path(policy.managed_checkpoint_root)
        filename = _absolute_path(policy.checkpoint_filename)
        _absolute_path(policy.owned_output_root)
        if filename == root or os.path.commonpath((root, filename)) != root:
            raise ValueError()
        if type(policy.checkpoint_bytes) is not int or not 0 < policy.checkpoint_bytes <= MAX_CHECKPOINT_BYTES:
            raise ValueError()
        if type(policy.checkpoint_sha256) is not str or not re.fullmatch(r'[0-9a-f]{64}', policy.checkpoint_sha256):
            raise ValueError()
        if type(policy.device) is not str or not re.fullmatch(r'cpu|cuda:(0|[1-9][0-9]*)', policy.device):
            raise ValueError()
        _policy = policy
    except Exception:
        _fail('INVALID_POLICY')


def require_owned_launch_policy():
    if _policy is None:
        _fail('UNAVAILABLE')
    return _policy


def _is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400))


def _identity(info):
    return info.st_dev, info.st_ino


def _fingerprint(info, include_change_time=True):
    signature = (_identity(info), info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns)
    # CPython 3.14 on Windows can expose creation time via lstat.st_ctime and
    # change time via fstat.st_ctime. Compare ctime only within the same API.
    return signature + (info.st_ctime_ns,) if include_change_time else signature


def _directory_chain(path):
    """Reject symlinks/reparse points in every existing ancestor (including root)."""
    path = Path(path)
    for entry in (*reversed(path.parents), path):
        info = os.lstat(entry)
        if _is_link(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError()
    return info


def _regular_single_file(info):
    if _is_link(info) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError()


def _verified_artifact(policy, snapshot):
    """One bounded open handle; optional immutable snapshot of those same bytes.

    These checks target ordinary owned local filesystems, not adversarial atomic
    filesystem or network-volume certification. No readiness/identity inference.
    """
    fd = None
    try:
        root_before = _directory_chain(policy.managed_checkpoint_root)
        _directory_chain(Path(policy.checkpoint_filename).parent)
        named_before = os.lstat(policy.checkpoint_filename)
        _regular_single_file(named_before)
        flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(policy.checkpoint_filename, flags)
        handle = os.fdopen(fd, 'rb')
        fd = None
        with handle:
            before = os.fstat(handle.fileno())
            _regular_single_file(before)
            if _fingerprint(before, False) != _fingerprint(named_before, False) or before.st_size != policy.checkpoint_bytes:
                raise ValueError()
            digest = hashlib.sha256()
            chunks = [] if snapshot else None
            total = 0
            while total < policy.checkpoint_bytes:
                chunk = handle.read(min(1024 * 1024, policy.checkpoint_bytes - total))
                if not chunk:
                    raise ValueError()
                total += len(chunk)
                digest.update(chunk)
                if snapshot:
                    chunks.append(chunk)
            if handle.read(1):
                raise ValueError()
            after = os.fstat(handle.fileno())
            named_after = os.lstat(policy.checkpoint_filename)
            _regular_single_file(after)
            _regular_single_file(named_after)
            _directory_chain(Path(policy.checkpoint_filename).parent)
            root_after = _directory_chain(policy.managed_checkpoint_root)
            if (_fingerprint(before) != _fingerprint(after) or
                    _fingerprint(named_before) != _fingerprint(named_after) or
                    _fingerprint(after, False) != _fingerprint(named_after, False) or
                    _identity(root_before) != _identity(root_after) or
                    digest.hexdigest() != policy.checkpoint_sha256):
                raise ValueError()
            data = b''.join(chunks) if snapshot else None
            return FileVerification(True, total, digest.hexdigest()), data
    except Exception:
        _fail('ARTIFACT_REJECTED')
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                _fail('ARTIFACT_REJECTED')


def inspect_checkpoint_file():
    """File verification ONLY, never runtime identity, readiness or capability."""
    policy = require_owned_launch_policy()
    verification, _ = _verified_artifact(policy, snapshot=False)
    return verification


def load_model_for_execution(*, input_image=None):
    """Artifact first; optional input preflight precedes model loading/device work.

    No cache, search, default weights, backend fallback, probing or retries.
    """
    policy = require_owned_launch_policy()
    _, data = _verified_artifact(policy, snapshot=True)
    try:
        import torch
        if input_image is not None:
            _unit_tensor(torch, input_image, 'INVALID_IMAGE')
        from ._inspyrenet.InSPyReNet import InSPyReNet_SwinB

        # Rehash the exact immutable in-memory bytes immediately before loading.
        with io.BytesIO(data) as checkpoint:
            if type(data) is not bytes or len(data) != policy.checkpoint_bytes or hashlib.sha256(data).hexdigest() != policy.checkpoint_sha256:
                _fail('ARTIFACT_REJECTED')
            state = torch.load(checkpoint, weights_only=True, map_location='cpu')
        del data
        model = InSPyReNet_SwinB(depth=64, pretrained=False, base_size=[1024, 1024], threshold=None)
        model.load_state_dict(state, strict=True)
        del state
        model.eval()
        model.to(policy.device)
        return torch, model, policy.device
    except OfflineError:
        raise
    except Exception:
        _fail('EXECUTION_FAILED')


def _image_shape(image):
    try:
        shape = tuple(image.shape)
        if len(shape) != 4 or any(type(n) is not int for n in shape):
            raise ValueError()
        batch, height, width, channels = shape
        if batch != 1 or channels not in (3, 4):
            raise ValueError()
        if not 0 < height <= MAX_DIMENSION or not 0 < width <= MAX_DIMENSION or height * width > MAX_PIXELS:
            raise ValueError()
        return height, width, channels
    except Exception:
        _fail('INVALID_IMAGE')


def _unit_tensor(torch, tensor, code):
    if (not torch.is_tensor(tensor) or tensor.layout != torch.strided or
            not tensor.is_floating_point() or tensor.device.type == 'meta'):
        _fail(code)
    if (not torch.isfinite(tensor).all().item() or (tensor < 0).any().item() or
            (tensor > 1).any().item()):
        _fail(code)


def remove_background(image):
    require_owned_launch_policy()
    height, width, channels = _image_shape(image)
    try:
        torch, model, device = load_model_for_execution(input_image=image)
        import torch.nn.functional as functional
        from .rgba8_png import Rgba8, validate_rgba8

        _unit_tensor(torch, image, 'INVALID_IMAGE')
        with torch.inference_mode():
            original = image.detach().to(device='cpu', dtype=torch.float32).clone()
            rgb = original[..., :3]
            tensor = rgb.permute(0, 3, 1, 2).to(device=device, dtype=torch.float32)
            tensor = functional.interpolate(tensor, size=(1024, 1024), mode='bilinear', align_corners=False)
            mean = torch.tensor([.485, .456, .406], device=device, dtype=torch.float32).reshape(1, 3, 1, 1)
            std = torch.tensor([.229, .224, .225], device=device, dtype=torch.float32).reshape(1, 3, 1, 1)
            prediction = model((tensor - mean) / std)
            _unit_tensor(torch, prediction, 'INVALID_ALPHA')
            if tuple(prediction.shape) != (1, 1, 1024, 1024):
                _fail('INVALID_ALPHA')
            alpha = functional.interpolate(prediction, size=(height, width), mode='bilinear', align_corners=False)
            alpha = alpha.permute(0, 2, 3, 1).to(device='cpu', dtype=torch.float32)
            if channels == 4:
                alpha = alpha * original[..., 3:4]
            _unit_tensor(torch, alpha, 'INVALID_ALPHA')
            rgba = torch.cat((rgb, alpha), dim=-1)
            # Explicit round-half-up for nonnegative samples. No numpy/PIL bridge.
            packed = (rgba * 255 + .5).to(dtype=torch.uint8).contiguous().reshape(-1)
            result = Rgba8(width, height, bytes(packed.tolist()))
            if not any(result.pixels[3::4]) or all(a == 255 for a in result.pixels[3::4]):
                _fail('INVALID_ALPHA')
            validate_rgba8(result)
            return result
    except OfflineError:
        raise
    except Exception:
        _fail('EXECUTION_FAILED')
