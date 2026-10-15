"""D04 stdlib contracts. Protocol fakes are NOT real tensor/model/GPU proof."""
import ast
import contextlib
import dataclasses
import hashlib
import importlib.abc
import importlib.util
import io
import itertools
import json
import math
import os
from pathlib import Path
import random
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import zlib

WORKSPACE = Path(__file__).resolve().parents[2]
BUNDLE = WORKSPACE / 'packages/runtime-assets/resources/comfy/magicpot_offline_rembg'
NAME = 'd04_test_bundle'
EVIDENCE_ROOT = Path(os.environ['TEMP'])
FORBIDDEN = {'torch', 'numpy', 'cv2', 'kornia', 'timm', 'transparent_background',
             'albumentations', 'PIL', 'comfy', 'server', 'folder_paths', 'requests',
             'huggingface_hub', 'gdown', 'onnxruntime'}
SOURCE_BASE = 'vendor/comfyui/python_embeded/Lib/site-packages/'
SOURCE_FILES = ['InSPyReNet.py', 'backbones/SwinTransformer.py', 'modules/layers.py',
                'modules/context_module.py', 'modules/attention_module.py', 'modules/decoder_module.py']
SOURCE_PAIRS = [(SOURCE_BASE + 'transparent_background/' + f, '_inspyrenet/' + f) for f in SOURCE_FILES]
SOURCE_PAIRS += [(SOURCE_BASE + 'transparent_background-1.3.4.dist-info/licenses/LICENSE', 'LICENSE.inspyrenet')]


class ImportGuard(importlib.abc.MetaPathFinder):
    def __init__(self):
        self.attempts = []

    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in FORBIDDEN:
            self.attempts.append(fullname)
            raise ImportError('UNPLANNED_DEPENDENCY')


GUARD = ImportGuard()
sys.meta_path.insert(0, GUARD)


def load_bundle():
    for key in tuple(sys.modules):
        if key == NAME or key.startswith(NAME + '.'):
            del sys.modules[key]
    spec = importlib.util.spec_from_file_location(NAME, BUNDLE / '__init__.py',
                                                submodule_search_locations=[str(BUNDLE)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[NAME] = module
    spec.loader.exec_module(module)
    return module


class Tensor:
    """Small representative-value fake; does not numerically simulate resize."""
    def __init__(self, values, shape, dtype='float32', device='cpu'):
        self.values, self.shape, self.dtype = list(values), tuple(shape), dtype
        self.device = types.SimpleNamespace(type=device.split(':')[0])
        self.layout = 'strided'

    def is_floating_point(self):
        return self.dtype in ('float32', 'float64', 'float16', 'bfloat16')

    def detach(self):
        return self

    def clone(self):
        return Tensor(self.values, self.shape, self.dtype)

    def to(self, device=None, dtype=None):
        vals = [int(v) for v in self.values] if dtype == 'uint8' else self.values
        return Tensor(vals, self.shape, dtype or self.dtype, device or 'cpu')

    def __getitem__(self, key):
        if not isinstance(key, tuple):
            key = (key,)
        if key[0] is Ellipsis:
            key = (slice(None),) * (len(self.shape) - len(key) + 1) + key[1:]
        key += (slice(None),) * (len(self.shape) - len(key))
        axes = [list(range(n))[k] if isinstance(k, slice) else [k] for n, k in zip(self.shape, key)]
        dims = [len(a) for a, k in zip(axes, key) if isinstance(k, slice)]
        vals = []
        for coord in itertools.product(*axes):
            idx = 0
            for n, c in zip(self.shape, coord):
                idx = idx * n + c
            vals.append(self.values[idx])
        return Tensor(vals, dims, self.dtype)

    def permute(self, *order):
        shape = tuple(self.shape[i] for i in order)
        if math.prod(shape) > 100:
            return Tensor(self.values, shape, self.dtype)
        vals = []
        for coord in itertools.product(*(range(n) for n in shape)):
            old = [0] * len(order)
            for i, axis in enumerate(order):
                old[axis] = coord[i]
            idx = 0
            for n, c in zip(self.shape, old):
                idx = idx * n + c
            vals.append(self.values[idx])
        return Tensor(vals, shape, self.dtype)

    def reshape(self, *shape):
        return Tensor(self.values, (len(self.values),) if shape == (-1,) else shape, self.dtype)

    def contiguous(self):
        return self

    def tolist(self):
        return self.values

    def all(self):
        return Tensor([all(self.values)], ())

    def any(self):
        return Tensor([any(self.values)], ())

    def item(self):
        return self.values[0]

    def _op(self, other, op):
        if isinstance(other, Tensor):
            if other.shape == (1, 3, 1, 1):
                span = len(self.values) // 3
                rhs = [other.values[i // span] for i in range(len(self.values))]
            else:
                rhs = other.values
            vals = [op(x, y) for x, y in zip(self.values, rhs)]
        else:
            vals = [op(x, other) for x in self.values]
        return Tensor(vals, self.shape, self.dtype)

    def __sub__(self, x):
        return self._op(x, lambda a, b: a - b)

    def __truediv__(self, x):
        return self._op(x, lambda a, b: a / b)

    def __mul__(self, x):
        return self._op(x, lambda a, b: a * b)

    def __add__(self, x):
        return self._op(x, lambda a, b: a + b)

    def __lt__(self, x):
        return self._op(x, lambda a, b: a < b)

    def __gt__(self, x):
        return self._op(x, lambda a, b: a > b)


def fake_runtime(events, prediction=(.25, .75), fail=None):
    torch = types.ModuleType('torch')
    torch.__path__ = []
    torch.Tensor, torch.float32, torch.uint8, torch.strided = Tensor, 'float32', 'uint8', 'strided'
    torch.is_tensor = lambda value: type(value) is Tensor
    torch.isfinite = lambda t: Tensor([math.isfinite(v) for v in t.values], t.shape)
    torch.tensor = lambda values, **kw: Tensor(values, (len(values),), **kw)
    torch.cuda = types.SimpleNamespace(is_available=mock.Mock(side_effect=AssertionError('DEVICE_PROBE')),
                                       current_device=mock.Mock(side_effect=AssertionError('DEVICE_PROBE')))

    @contextlib.contextmanager
    def inference_mode():
        events.append(('inference_enter',))
        try:
            yield
        finally:
            events.append(('inference_exit',))
    torch.inference_mode = inference_mode

    def load(handle, **kw):
        events.append(('load', handle.read(), kw, type(handle)))
        if fail == 'load':
            raise RuntimeError('C:/fixture-data/path/checkpoint')
        return {'synthetic_state': 1}
    torch.load = load

    def cat(tensors, dim):
        assert dim == -1
        left, right = tensors
        vals = []
        for i, alpha in enumerate(right.values):
            vals.extend(left.values[i * 3:i * 3 + 3] + [alpha])
        return Tensor(vals, left.shape[:-1] + (4,))
    torch.cat = cat
    nn = types.ModuleType('torch.nn')
    nn.__path__ = []
    functional = types.ModuleType('torch.nn.functional')

    def interpolate(tensor, **kw):
        events.append(('interpolate', dict(kw), tuple(tensor.values)))
        h, w = kw['size']
        count = h * w * tensor.shape[1]
        values = tensor.values if count > 100 else [tensor.values[i % len(tensor.values)] for i in range(count)]
        return Tensor(values, (1, tensor.shape[1], h, w))
    functional.interpolate = interpolate
    torch.nn, nn.functional = nn, functional
    model_module = types.ModuleType(NAME + '._inspyrenet.InSPyReNet')

    class Model:
        def load_state_dict(self, state, **kw):
            events.append(('strict', state, kw))
            if fail == 'strict':
                raise ValueError('/fixture-data/model')

        def eval(self):
            events.append(('eval',))
            if fail == 'eval':
                raise RuntimeError('/fixture-data/eval')
            return self

        def to(self, device):
            events.append(('device', device))
            if fail == 'device':
                raise RuntimeError('/fixture-data/device')
            return self

        def __call__(self, image):
            events.append(('model', image.shape, tuple(image.values)))
            if fail == 'model':
                raise RuntimeError('/fixture-data/forward')
            return Tensor(prediction, (1, 1, 1024, 1024))

    def factory(**kw):
        events.append(('factory', kw))
        if fail == 'factory':
            raise RuntimeError('/fixture-data/factory')
        return Model()
    model_module.InSPyReNet_SwinB = factory
    return {'torch': torch, 'torch.nn': nn, 'torch.nn.functional': functional,
            NAME + '._inspyrenet.InSPyReNet': model_module}


class StripDocstrings(ast.NodeTransformer):
    def visit_Expr(self, node):
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            return None
        return self.generic_visit(node)


def mathematics_ast(path, upstream=False):
    tree = ast.parse(path.read_text(encoding='utf-8'))
    if upstream:
        tree.body = [n for n in tree.body if not (
            isinstance(n, ast.Import) and any(a.name in ('os', 'sys') for a in n.names) or
            isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ('filepath', 'repopath') for t in n.targets) or
            isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and ast.unparse(n.value.func) == 'sys.path.append')]
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith('transparent_background.'):
                node.module = node.module.removeprefix('transparent_background.')
                if path.name == 'attention_module.py':
                    node.module = 'layers'
                node.level = 1
    tree.body = [n for n in tree.body if not isinstance(n, ast.FunctionDef) or n.name not in ('SwinT', 'SwinS', 'SwinL')]
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            node.body = [n for n in node.body if not isinstance(n, ast.FunctionDef) or n.name not in ('cuda', 'init_weights')]
        if isinstance(node, ast.FunctionDef) and node.name == 'SwinB':
            # Only the explicit disabled-pretraining wrapper differs. Compare
            # its actual model constructor call against the upstream call.
            call = node.body[0].value if upstream else node.body[-1].value
            node.body = [ast.Return(value=call)]
            node.args.defaults = []
    return ast.dump(StripDocstrings().visit(tree), include_attributes=False)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.guard_start = len(GUARD.attempts)
        self.bundle = load_bundle()
        self.loader = sys.modules[NAME + '.offline_loader']
        self.png = sys.modules[NAME + '.rgba8_png']
        self.temp = tempfile.TemporaryDirectory(prefix='fixture-', dir=EVIDENCE_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.models, self.output = self.root / 'models', self.root / 'output'
        self.models.mkdir()
        self.output.mkdir()
        self.checkpoint = self.models / 'tiny.synthetic'
        self.payload = b'D04 synthetic test checkpoint, not a production manifest\x00'
        self.checkpoint.write_bytes(self.payload)
        self.policy = self.loader.OwnedLaunchPolicy(
            managed_checkpoint_root=str(self.models), checkpoint_filename=str(self.checkpoint),
            checkpoint_bytes=len(self.payload), checkpoint_sha256=hashlib.sha256(self.payload).hexdigest(),
            device='cpu', owned_output_root=str(self.output))

    def install(self, **changes):
        policy = dataclasses.replace(self.policy, **changes)
        self.loader.install_trusted_owned_launch_policy(policy)
        return policy

    def error(self, code, fn, *args):
        with self.assertRaises(self.loader.OfflineError) as caught:
            fn(*args)
        self.assertEqual(str(caught.exception), code)
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__)

    def assert_disabled(self):
        self.error('UNAVAILABLE', self.loader.inspect_checkpoint_file)

    def test_discovery_schema_construction_inert(self):
        self.assertEqual(set(self.bundle.NODE_CLASS_MAPPINGS), {'MagicPotOfflineInspyrenetV1', 'MagicPotSaveRgba8V1'})
        for cls in self.bundle.NODE_CLASS_MAPPINGS.values():
            cls()
            self.assertEqual(set(cls.INPUT_TYPES()['required']), {'image'})
            self.assertFalse(cls.INPUT_TYPES().get('optional'))
            self.assertFalse(cls.INPUT_TYPES().get('hidden'))
        self.assertTrue(self.bundle.NODE_CLASS_MAPPINGS['MagicPotSaveRgba8V1'].OUTPUT_NODE)
        for suffix in ('._inspyrenet', '._inspyrenet.modules', '._inspyrenet.backbones'):
            importlib.import_module(NAME + suffix)
        self.assertEqual(len(GUARD.attempts), self.guard_start)
        self.assert_disabled()
        self.error('UNAVAILABLE', self.bundle.NODE_CLASS_MAPPINGS['MagicPotOfflineInspyrenetV1']().remove, None)
        self.error('UNAVAILABLE', self.bundle.NODE_CLASS_MAPPINGS['MagicPotSaveRgba8V1']().save, None)

    def test_policy_install_no_checkpoint_read_and_frozen(self):
        with mock.patch('os.open', side_effect=AssertionError('READ')), mock.patch('os.lstat', side_effect=AssertionError('STAT')):
            self.install()
        with self.assertRaises(dataclasses.FrozenInstanceError):
            self.policy.device = 'cuda:0'
        self.assertEqual(len(GUARD.attempts), self.guard_start)
        self.bundle.disable_owned_launch_policy()
        self.assert_disabled()

    def test_no_environment_policy(self):
        with mock.patch.dict(os.environ, {'MAGICPOT_OFFLINE_POLICY': json.dumps(dataclasses.asdict(self.policy))}):
            self.assert_disabled()

    def test_policy_exact_fields_and_validation(self):
        invalid = {'checkpoint_bytes': [True, 0, -1, 512 * 1024 * 1024 + 1, '1'],
                   'checkpoint_sha256': ['a' * 63, 'A' * 64, 'g' * 64, None],
                   'device': ['', 'CPU', 'cuda', 'cuda:01', 'cuda:-1', 'cuda:0 ', 'mps', None],
                   'checkpoint_filename': ['relative.ckpt', str(self.root / 'escape'), str(self.models / '..' / 'escape')],
                   'managed_checkpoint_root': ['relative', ''], 'owned_output_root': ['relative', '']}
        if os.name == 'nt':
            invalid['checkpoint_filename'] += [str(self.checkpoint) + ':stream', 'C:/NUL', '//server/share/model']
        for field, values in invalid.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.install()
                    forged = dataclasses.replace(self.policy)
                    object.__setattr__(forged, field, value)
                    self.error('INVALID_POLICY', self.loader.install_trusted_owned_launch_policy, forged)
                    self.assert_disabled()
        self.error('INVALID_POLICY', self.loader.install_trusted_owned_launch_policy, dataclasses.asdict(self.policy))
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_inspection_file_only(self):
        self.install()
        result = self.loader.inspect_checkpoint_file()
        self.assertEqual(dataclasses.asdict(result), {'file_verified': True, 'byte_count': len(self.payload),
                                                     'sha256': hashlib.sha256(self.payload).hexdigest()})
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_missing_wrong_size_digest_and_directory(self):
        for mode in ('missing', 'size', 'digest', 'directory'):
            with self.subTest(mode=mode):
                if self.checkpoint.exists():
                    self.checkpoint.unlink()
                if mode == 'directory':
                    self.checkpoint.mkdir()
                elif mode == 'size':
                    self.checkpoint.write_bytes(self.payload + b'!')
                elif mode == 'digest':
                    self.checkpoint.write_bytes(b'X' * len(self.payload))
                self.install()
                self.error('ARTIFACT_REJECTED', self.loader.load_model_for_execution)
                self.assert_disabled()
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_hardlink_checkpoint_rejected(self):
        os.link(self.checkpoint, self.models / 'alias')
        self.install()
        self.error('ARTIFACT_REJECTED', self.loader.load_model_for_execution)
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_symlink_checkpoint_and_output_ancestor_rejected(self):
        alias = self.root / 'alias'
        try:
            alias.symlink_to(self.models, target_is_directory=True)
        except OSError as exc:
            self.skipTest('OS symlink privilege unavailable: ' + str(exc.winerror if os.name == 'nt' else exc.errno))
        self.install(managed_checkpoint_root=str(alias), checkpoint_filename=str(alias / self.checkpoint.name))
        self.error('ARTIFACT_REJECTED', self.loader.load_model_for_execution)
        self.install(owned_output_root=str(alias))
        self.error('OUTPUT_REJECTED', self.png.save_owned_rgba8, self.png.Rgba8(1, 1, b'abc\x80'))
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    @unittest.skipUnless(os.name == 'nt', 'Windows reparse-point test')
    def test_real_windows_junction_checkpoint_and_output_ancestor(self):
        import _winapi
        alias = self.root / 'junction'
        _winapi.CreateJunction(str(self.models), str(alias))
        self.addCleanup(os.rmdir, alias)
        self.assertTrue(os.lstat(alias).st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
        self.install(managed_checkpoint_root=str(alias), checkpoint_filename=str(alias / self.checkpoint.name))
        self.error('ARTIFACT_REJECTED', self.loader.load_model_for_execution)
        self.install(owned_output_root=str(alias))
        self.error('OUTPUT_REJECTED', self.png.save_owned_rgba8, self.png.Rgba8(1, 1, b'abc\x80'))
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_changed_file_during_hash_rejected_and_handle_closed(self):
        real, handles, original_fdopen = self.loader.hashlib.sha256, [], os.fdopen

        def fdopen(*args, **kw):
            handle = original_fdopen(*args, **kw)
            handles.append(handle)
            return handle

        class MutatingHash:
            def __init__(inner, *args):
                inner.hash = real(*args)

            def update(inner, data):
                inner.hash.update(data)
                self.checkpoint.write_bytes(b'Y' * len(self.payload))

            def hexdigest(inner):
                return inner.hash.hexdigest()
        self.install()
        with mock.patch.object(self.loader.hashlib, 'sha256', MutatingHash), mock.patch('os.fdopen', fdopen):
            self.error('ARTIFACT_REJECTED', self.loader.load_model_for_execution)
        self.assertTrue(handles)
        self.assertTrue(all(h.closed for h in handles))
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_exact_deserialization_flags_factory_order_and_device(self):
        for device in ('cpu', 'cuda:12'):
            self.install(device=device)
            events = []
            with mock.patch.dict(sys.modules, fake_runtime(events)):
                self.loader.load_model_for_execution()
            self.assertEqual(events, [
                ('load', self.payload, {'weights_only': True, 'map_location': 'cpu'}, io.BytesIO),
                ('factory', {'depth': 64, 'pretrained': False, 'base_size': [1024, 1024], 'threshold': None}),
                ('strict', {'synthetic_state': 1}, {'strict': True}), ('eval',), ('device', device)])

    def test_same_snapshot_not_path_reopened(self):
        self.install()
        events, changed, original_import = [], [], __import__

        def changing_import(name, *args, **kw):
            if name == 'torch' and not changed:
                changed.append(True)
                self.checkpoint.write_bytes(b'Z' * len(self.payload))
            return original_import(name, *args, **kw)
        with mock.patch.dict(sys.modules, fake_runtime(events)), mock.patch('builtins.__import__', changing_import):
            self.loader.load_model_for_execution()
        self.assertTrue(changed)
        self.assertEqual(events[0][1], self.payload)
        self.assertEqual(self.checkpoint.read_bytes(), b'Z' * len(self.payload))

    def test_snapshot_rehashed_immediately_before_load(self):
        self.install()
        events = []
        # Corrupt only the private snapshot boundary, not real path verification.
        original = self.loader._verified_artifact

        def corrupt(policy, snapshot):
            result, data = original(policy, snapshot)
            return result, b'Q' * len(data)
        with mock.patch.dict(sys.modules, fake_runtime(events)), mock.patch.object(self.loader, '_verified_artifact', corrupt):
            self.error('ARTIFACT_REJECTED', self.loader.load_model_for_execution)
        self.assertEqual(events, [])
        self.assert_disabled()

    def test_dependency_failure_never_fallback(self):
        self.install()
        self.error('EXECUTION_FAILED', self.loader.load_model_for_execution)
        self.assertEqual(GUARD.attempts[self.guard_start:], ['torch'])
        self.assert_disabled()

    def test_model_failures_never_retry_or_fallback(self):
        for failure in ('load', 'factory', 'strict', 'eval', 'device', 'model'):
            self.install(device='cuda:3')
            events = []
            with mock.patch.dict(sys.modules, fake_runtime(events, fail=failure)):
                fn = self.loader.remove_background if failure == 'model' else self.loader.load_model_for_execution
                args = (Tensor([.1, .2, .3, .4, .5, .6], (1, 1, 2, 3)),) if failure == 'model' else ()
                self.error('EXECUTION_FAILED', fn, *args)
            self.assertEqual(sum(e[0] == 'load' for e in events), 1)
            self.assertLessEqual(sum(e[0] == 'device' for e in events), 1)
            self.assert_disabled()

    def test_rgb_rgba_normalization_resize_alpha_and_rgb_preservation(self):
        for channels in (3, 4):
            self.install()
            events = []
            pixels = [.1, .2, .3, .4, .5, .6] if channels == 3 else [.1, .2, .3, .5, .4, .5, .6, .25]
            image = Tensor(pixels, (1, 1, 2, channels))
            with mock.patch.dict(sys.modules, fake_runtime(events)):
                result = self.bundle.NODE_CLASS_MAPPINGS['MagicPotOfflineInspyrenetV1']().remove(image)[0]
            self.assertEqual((result.width, result.height), (2, 1))
            expected_alpha = [64, 191] if channels == 3 else [32, 48]
            self.assertEqual(result.pixels, bytes([26, 51, 77, expected_alpha[0], 102, 128, 153, expected_alpha[1]]))
            self.assertEqual(image.values, pixels)
            sizes = [e[1] for e in events if e[0] == 'interpolate']
            self.assertEqual(sizes, [{'size': (1024, 1024), 'mode': 'bilinear', 'align_corners': False},
                                     {'size': (1, 2), 'mode': 'bilinear', 'align_corners': False}])
            self.assertIn(('inference_enter',), events)
            self.assertIn(('inference_exit',), events)
            model_values = next(e[2] for e in events if e[0] == 'model')
            for got, want in zip(model_values, [(v - m) / s for v, m, s in
                                               zip([.1, .4, .2, .5, .3, .6], [.485, .485, .456, .456, .406, .406],
                                                   [.229, .229, .224, .224, .225, .225])]):
                self.assertAlmostEqual(got, want)

    def test_shape_limits_before_heavy_import(self):
        for shape in ((2, 1, 1, 3), (1, 0, 1, 3), (1, 4097, 1, 3), (1, 2049, 2049, 3),
                      (1, 1, 1, 2), (1, 1, 1), (True, 1, 1, 3)):
            self.install()
            self.error('INVALID_IMAGE', self.loader.remove_background, Tensor([], shape))
        for shape in ((1, 4096, 1, 3), (1, 2048, 2048, 4)):
            self.assertEqual(self.loader._image_shape(Tensor([], shape)), shape[1:])
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_all_input_pixels_finite_bounded_and_float(self):
        for bad in (float('nan'), float('inf'), -.001, 1.001):
            self.install()
            events = []
            with mock.patch.dict(sys.modules, fake_runtime(events)):
                self.error('INVALID_IMAGE', self.loader.remove_background, Tensor([.1, .2, .3, .4, .5, bad], (1, 1, 2, 3)))
            self.assertFalse(any(e[0] == 'model' for e in events))
        for image in (Tensor([1, 2, 3], (1, 1, 1, 3), dtype='uint8'), types.SimpleNamespace(shape=(1, 1, 1, 3))):
            self.install()
            with mock.patch.dict(sys.modules, fake_runtime([])):
                self.error('INVALID_IMAGE', self.loader.remove_background, image)

    def test_invalid_input_does_not_deserialize_construct_or_move_model(self):
        invalid = [Tensor([.1, .2, bad], (1, 1, 1, 3))
                   for bad in (float('nan'), float('inf'), -.001, 1.001)]
        invalid.extend([Tensor([1, 2, 3], (1, 1, 1, 3), dtype='uint8'),
                        types.SimpleNamespace(shape=(1, 1, 1, 3))])
        for image in invalid:
            with self.subTest(image_type=type(image).__name__):
                self.install()
                events = []
                with mock.patch.dict(sys.modules, fake_runtime(events, fail='load')):
                    self.error('INVALID_IMAGE', self.loader.remove_background, image)
                self.assertEqual(events, [])
                self.assert_disabled()

    def test_input_preflight_retains_artifact_first_gate_without_model_import(self):
        self.install()
        self.checkpoint.write_bytes(b'Z' * len(self.payload))
        events = []
        with mock.patch.dict(sys.modules, fake_runtime(events)):
            self.error('ARTIFACT_REJECTED', self.loader.remove_background,
                       Tensor([float('nan'), .2, .3], (1, 1, 1, 3)))
        self.assertEqual(events, [])
        self.assertEqual(len(GUARD.attempts), self.guard_start)
        self.assert_disabled()

    def test_prediction_and_combined_alpha_rejected(self):
        for prediction in ((0, 0), (1, 1), (float('nan'), .5), (.5, float('inf')), (-.01, .5), (.5, 1.01), (.0001, .0001), (.9999, .9999)):
            self.install()
            with mock.patch.dict(sys.modules, fake_runtime([], prediction=prediction)):
                self.error('INVALID_ALPHA', self.loader.remove_background, Tensor([.1] * 6, (1, 1, 2, 3)))
        self.install()
        with mock.patch.dict(sys.modules, fake_runtime([])):
            self.error('INVALID_ALPHA', self.loader.remove_background, Tensor([.1, .2, .3, 0] * 2, (1, 1, 2, 4)))

    def test_png_roundtrip_chunks_crc_and_exact_bytes(self):
        pixels = bytes([1, 2, 3, 0, 4, 5, 6, 255, 7, 8, 9, 128, 10, 11, 12, 64])
        encoded = self.png.encode_rgba8(self.png.Rgba8(2, 2, pixels))
        self.assertEqual(encoded[:8], b'\x89PNG\r\n\x1a\n')
        offset, chunks = 8, []
        while offset < len(encoded):
            size = struct.unpack('>I', encoded[offset:offset + 4])[0]
            kind, data = encoded[offset + 4:offset + 8], encoded[offset + 8:offset + 8 + size]
            crc = struct.unpack('>I', encoded[offset + 8 + size:offset + 12 + size])[0]
            self.assertEqual(crc, zlib.crc32(kind + data) & 0xffffffff)
            chunks.append((kind, data))
            offset += 12 + size
        self.assertEqual([c[0] for c in chunks], [b'IHDR', b'IDAT', b'IEND'])
        self.assertEqual(struct.unpack('>IIBBBBB', chunks[0][1]), (2, 2, 8, 6, 0, 0, 0))
        self.assertEqual(zlib.decompress(chunks[1][1]), b'\0' + pixels[:8] + b'\0' + pixels[8:])
        self.assertEqual(offset, len(encoded))

    def test_png_invalid_dimensions_bytes_and_alpha(self):
        for image in (self.png.Rgba8(True, 1, b'abcd'), self.png.Rgba8(0, 1, b''),
                      self.png.Rgba8(4097, 1, b''), self.png.Rgba8(2049, 2049, b''),
                      self.png.Rgba8(1, 1, bytearray(b'abcd')), self.png.Rgba8(1, 1, b'abc'),
                      self.png.Rgba8(1, 1, b'abc\0'), self.png.Rgba8(1, 1, b'abc\xff')):
            self.error('INVALID_RGBA8', self.png.encode_rgba8, image)

    def test_png_encoded_four_mib_limit(self):
        data = random.Random(404).randbytes(1024 * 1024 * 4)
        self.error('PNG_TOO_LARGE', self.png.encode_rgba8, self.png.Rgba8(1024, 1024, data))
        encoded = self.png.encode_rgba8(self.png.Rgba8(2048, 2048, b'abc\x80' * (2048 * 2048)))
        self.assertLessEqual(len(encoded), 4 * 1024 * 1024)

    def test_save_unique_locator_no_overwrite_no_caller_path(self):
        self.install()
        image = self.png.Rgba8(1, 1, b'abc\x80')
        node = self.bundle.NODE_CLASS_MAPPINGS['MagicPotSaveRgba8V1']()
        first, second = node.save(image)['ui']['images'][0], node.save(image)['ui']['images'][0]
        self.assertNotEqual(first['filename'], second['filename'])
        self.assertRegex(first['filename'], r'^magicpot-rgba8-[0-9a-f]{32}\.png$')
        self.assertEqual({k: first[k] for k in ('subfolder', 'type')}, {'subfolder': '', 'type': 'output'})
        self.assertEqual((self.output / first['filename']).read_bytes(), self.png.encode_rgba8(image))
        with mock.patch.object(self.png.secrets, 'token_hex', return_value='0' * 32):
            existing = self.output / ('magicpot-rgba8-' + '0' * 32 + '.png')
            existing.write_bytes(b'owned earlier')
            self.error('OUTPUT_REJECTED', node.save, image)
            self.assertEqual(existing.read_bytes(), b'owned earlier')
        self.assertEqual(len(GUARD.attempts), self.guard_start)

    def test_save_same_handle_write_flush_fsync(self):
        self.install()
        handles, synced = [], []
        original_fdopen, original_fsync = os.fdopen, os.fsync

        def fdopen(*args, **kw):
            handle = original_fdopen(*args, **kw)
            handles.append(handle)
            return handle

        def fsync(fd):
            self.assertEqual(fd, handles[0].fileno())
            self.assertGreater(os.fstat(fd).st_size, 0)
            synced.append(fd)
            return original_fsync(fd)
        with mock.patch('os.fdopen', fdopen), mock.patch('os.fsync', fsync):
            self.png.save_owned_rgba8(self.png.Rgba8(1, 1, b'abc\x80'))
        self.assertEqual(len(handles), 1)
        self.assertEqual(len(synced), 1)
        self.assertTrue(handles[0].closed)

    def test_save_fsync_failure_cleans_only_own_file(self):
        self.install()
        existing = self.output / 'keep.png'
        existing.write_bytes(b'keep')
        with mock.patch('os.fsync', side_effect=OSError('/fixture-data/output')):
            self.error('OUTPUT_REJECTED', self.png.save_owned_rgba8, self.png.Rgba8(1, 1, b'abc\x80'))
        self.assertEqual(list(self.output.iterdir()), [existing])
        self.assert_disabled()

    def test_cleanup_does_not_remove_replacement(self):
        path, other = self.output / 'owned.png', self.output / 'replacement.png'
        path.write_bytes(b'first')
        original = os.lstat(path)
        other.write_bytes(b'replacement')
        os.replace(other, path)
        self.png._cleanup_owned_file(path, original)
        self.assertEqual(path.read_bytes(), b'replacement')

    def test_save_missing_root_and_unsafe_token(self):
        self.install(owned_output_root=str(self.root / 'missing'))
        self.error('OUTPUT_REJECTED', self.png.save_owned_rgba8, self.png.Rgba8(1, 1, b'abc\x80'))
        self.install()
        with mock.patch.object(self.png.secrets, 'token_hex', return_value='../escape'):
            self.error('OUTPUT_REJECTED', self.png.save_owned_rgba8, self.png.Rgba8(1, 1, b'abc\x80'))
        self.assertFalse((self.root / 'escape').exists())

    def test_bundled_mathematics_ast_matches_local_sources(self):
        for source, destination in SOURCE_PAIRS[:-1]:
            with self.subTest(file=destination):
                self.assertEqual(mathematics_ast(WORKSPACE / source, True), mathematics_ast(BUNDLE / destination))

    def test_provenance_local_hashes_license_and_static_private_sources(self):
        provenance = json.loads((BUNDLE / 'provenance.json').read_text(encoding='utf-8'))
        self.assertEqual(len(provenance['sources']), 7)
        self.assertEqual([(i['source_path'], i['bundle_path']) for i in provenance['sources']], SOURCE_PAIRS)
        for item in provenance['sources']:
            self.assertEqual(hashlib.sha256((WORKSPACE / item['source_path']).read_bytes()).hexdigest(), item['source_sha256'])
            self.assertEqual(hashlib.sha256((BUNDLE / item['bundle_path']).read_bytes()).hexdigest(), item['bundle_sha256'])
        # Verbatim license TEXT; tool writes CRLF on Windows. Raw hashes above
        # deliberately record the difference rather than asserting byte identity.
        source_license = (WORKSPACE / SOURCE_PAIRS[-1][0]).read_bytes()
        bundle_license = (BUNDLE / 'LICENSE.inspyrenet').read_bytes()
        self.assertEqual(source_license, bundle_license.replace(b'\r\n', b'\n'))
        for path in (BUNDLE / '_inspyrenet').rglob('*.py'):
            source = path.read_text(encoding='utf-8')
            compile(source, str(path), 'exec')
            for forbidden in ('transparent_background', 'sys.path', 'torch.load', 'current_device'):
                self.assertNotIn(forbidden, source)
        self.assertIn('Copyright (c) 2021 Microsoft', (BUNDLE / '_inspyrenet/backbones/SwinTransformer.py').read_text(encoding='utf-8'))


if __name__ == '__main__':
    if not EVIDENCE_ROOT.name.startswith('d04-offline-node-worker-'):
        raise SystemExit('Explicit d04 private-trash TEMP required')
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    phase = sys.argv[1] if len(sys.argv) > 1 else 'green'
    if phase not in ('red', 'green'):
        raise SystemExit('Expected red or green')
    stream = io.StringIO()
    with mock.patch.object(socket, 'socket', side_effect=AssertionError('NETWORK')), \
            mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('SUBPROCESS')):
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RuntimeTests))
    report = stream.getvalue()
    (EVIDENCE_ROOT / (phase.upper() + '.txt')).write_text(report, encoding='utf-8')
    if phase == 'green':
        sources = [{'source_path': s, 'bundle_path': d,
                    'source_sha256': hashlib.sha256((WORKSPACE / s).read_bytes()).hexdigest(),
                    'bundle_sha256': hashlib.sha256((BUNDLE / d).read_bytes()).hexdigest()}
                   for s, d in SOURCE_PAIRS]
        evidence = {'python': sys.version, 'tests': result.testsRun, 'failures': len(result.failures),
                    'errors': len(result.errors), 'skipped': len(result.skipped), 'sources': sources,
                    'limits': 'stdlib and protocol fakes only; no real torch/model/GPU/Comfy/network'}
        (EVIDENCE_ROOT / 'report.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    print(report, end='')
    print('EVIDENCE_ROOT=' + str(EVIDENCE_ROOT))
    sys.exit(not result.wasSuccessful())
