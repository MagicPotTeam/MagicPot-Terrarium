"""Discovery/schema/construction import only stdlib-backed local adapters."""
from .offline_loader import remove_background
from .rgba8_png import save_owned_rgba8


class MagicPotOfflineInspyrenetV1:
    CATEGORY = 'MagicPot/offline-opt-in'
    RETURN_TYPES = ('MAGICPOT_RGBA8_V1',)
    RETURN_NAMES = ('rgba8',)
    FUNCTION = 'remove'

    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'image': ('IMAGE',)}}

    def remove(self, image):
        return (remove_background(image),)


class MagicPotSaveRgba8V1:
    CATEGORY = 'MagicPot/offline-opt-in'
    RETURN_TYPES = ()
    FUNCTION = 'save'
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'image': ('MAGICPOT_RGBA8_V1',)}}

    def save(self, image):
        return {'ui': {'images': [save_owned_rgba8(image)]}}
