"""UNWIRED offline nodes. Discovery does not install policy or load a model."""
from .nodes import MagicPotOfflineInspyrenetV1, MagicPotSaveRgba8V1
from .offline_loader import OwnedLaunchPolicy, install_trusted_owned_launch_policy, disable_owned_launch_policy

NODE_CLASS_MAPPINGS = {
    'MagicPotOfflineInspyrenetV1': MagicPotOfflineInspyrenetV1,
    'MagicPotSaveRgba8V1': MagicPotSaveRgba8V1,
}

__all__ = ['NODE_CLASS_MAPPINGS', 'OwnedLaunchPolicy',
           'install_trusted_owned_launch_policy', 'disable_owned_launch_policy']
