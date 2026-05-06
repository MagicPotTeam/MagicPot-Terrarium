import argparse
import json
import math
from pathlib import Path


def normalize_vector(values):
    norm = math.sqrt(sum(value * value for value in values))
    if norm <= 0:
        return values
    return [value / norm for value in values]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def load_runtime():
    try:
        import numpy as np
    except Exception as exc:
        raise RuntimeError(f"numpy import failed: {exc}") from exc

    try:
        import onnxruntime as ort
    except Exception as exc:
        raise RuntimeError(f"onnxruntime import failed: {exc}") from exc

    try:
        from PIL import Image, ImageEnhance, ImageOps
    except Exception as exc:
        raise RuntimeError(f"Pillow import failed: {exc}") from exc

    return np, ort, Image, ImageEnhance, ImageOps


def resolve_providers(ort, use_gpu, fallback_to_cpu):
    available = list(ort.get_available_providers())
    if use_gpu and "CUDAExecutionProvider" in available:
        providers = ["CUDAExecutionProvider"]
        if fallback_to_cpu:
            providers.append("CPUExecutionProvider")
        return providers

    if use_gpu and not fallback_to_cpu:
        raise RuntimeError("CUDAExecutionProvider is unavailable in the current Python runtime.")

    return ["CPUExecutionProvider"]


def create_session(ort, payload):
    model = payload["model"]
    providers = resolve_providers(
        ort,
        bool(payload.get("useGpu")),
        bool(payload.get("fallbackToCpu", True)),
    )
    session = ort.InferenceSession(model["modelPath"], providers=providers)
    provider = session.get_providers()[0] if session.get_providers() else "CPUExecutionProvider"
    return session, provider


def preprocess_image(np, pil_image, size, mean, std):
    image = pil_image.convert("RGB").resize((size, size))
    array = np.asarray(image).astype("float32") / 255.0
    array = (array - np.asarray(mean, dtype="float32")) / np.asarray(std, dtype="float32")
    array = np.transpose(array, (2, 0, 1))
    return np.expand_dims(array, axis=0)


def flatten_embedding(np, raw_output):
    return np.asarray(raw_output, dtype="float32").reshape(-1).tolist()


def infer_batch_embeddings(np, session, input_name, output_name, payload, images):
    model = payload["model"]
    if not images:
        return []

    batch = np.concatenate(
        [
            preprocess_image(
                np,
                image,
                int(model.get("inputSize") or 224),
                model.get("mean") or [0.5, 0.5, 0.5],
                model.get("std") or [0.5, 0.5, 0.5],
            )
            for image in images
        ],
        axis=0,
    )

    output = session.run([output_name], {input_name: batch})[0]
    output_array = np.asarray(output, dtype="float32")
    if output_array.ndim == 1:
        output_array = np.expand_dims(output_array, axis=0)

    embeddings = [flatten_embedding(np, output_array[index]) for index in range(output_array.shape[0])]
    if model.get("normalizeEmbedding", True):
        embeddings = [normalize_vector(embedding) for embedding in embeddings]
    return embeddings


def infer_robust_embedding(np, session, input_name, output_name, payload, image, ImageEnhance, ImageOps):
    augmentations = [
        image,
        ImageOps.autocontrast(image),
        ImageEnhance.Brightness(image).enhance(0.85),
        ImageEnhance.Brightness(image).enhance(1.15),
        image.crop(
            (
                image.width * 0.04,
                image.height * 0.04,
                image.width * 0.96,
                image.height * 0.96,
            )
        ),
    ]
    embeddings = infer_batch_embeddings(np, session, input_name, output_name, payload, augmentations)
    if not embeddings:
        return []

    merged = []
    for index in range(len(embeddings[0])):
        merged.append(sum(values[index] for values in embeddings) / len(embeddings))
    if payload["model"].get("normalizeEmbedding", True):
        merged = normalize_vector(merged)
    return merged


def open_images(Image, image_specs):
    opened = []
    failed_items = []
    for image_spec in image_specs:
        try:
            with Image.open(image_spec["path"]) as pil_image:
                opened.append((image_spec, pil_image.copy()))
        except Exception as exc:
            failed_items.append({"id": image_spec["id"], "error": str(exc)})
    return opened, failed_items


def main():
    args = parse_args()
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    np, ort, Image, ImageEnhance, ImageOps = load_runtime()
    session, provider = create_session(ort, payload)

    input_name = payload["model"].get("inputName") or session.get_inputs()[0].name
    output_name = payload["model"].get("outputName") or session.get_outputs()[0].name
    batch_size = max(1, int(payload.get("batchSize") or 1))
    enable_robustness = bool(payload.get("enableRobustness"))

    items = []
    image_specs = payload.get("images", [])
    for start in range(0, len(image_specs), batch_size):
        batch_specs = image_specs[start : start + batch_size]
        opened, failed_items = open_images(Image, batch_specs)
        items.extend(failed_items)
        if not opened:
            continue

        try:
            pil_images = [image for _, image in opened]
            embeddings = infer_batch_embeddings(
                np, session, input_name, output_name, payload, pil_images
            )

            for (image_spec, pil_image), embedding in zip(opened, embeddings):
                robust_embedding = None
                if enable_robustness:
                    robust_embedding = infer_robust_embedding(
                        np,
                        session,
                        input_name,
                        output_name,
                        payload,
                        pil_image,
                        ImageEnhance,
                        ImageOps,
                    )
                items.append(
                    {
                        "id": image_spec["id"],
                        "embedding": embedding,
                        "robustEmbedding": robust_embedding,
                    }
                )
        except Exception as exc:
            for image_spec, _ in opened:
                items.append({"id": image_spec["id"], "error": str(exc)})
        finally:
            for _, pil_image in opened:
                try:
                    pil_image.close()
                except Exception:
                    pass

    Path(args.output).write_text(
        json.dumps({"provider": provider, "items": items}, ensure_ascii=False),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
