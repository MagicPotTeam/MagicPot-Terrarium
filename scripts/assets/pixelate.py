import sys

try:
    from PIL import Image
    import sys
    
    def pixelate(input_path, output_path, pixel_size):
        image = Image.open(input_path)
        small = image.resize(
            (max(1, image.width // pixel_size), max(1, image.height // pixel_size)),
            resample=Image.NEAREST
        )
        result = small.resize(
            (image.width, image.height),
            resample=Image.NEAREST
        )
        result.save(output_path)
    
    input_img = 'input.jpg'
    pixelate(input_img, 'pixelated_2x.jpg', 2)
    pixelate(input_img, 'pixelated_4x.jpg', 4)
    pixelate(input_img, 'pixelated_8x.jpg', 8)
    print("Success")
except Exception as e:
    print(f"Error: {e}")
