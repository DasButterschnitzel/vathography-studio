#!/usr/bin/env python3
"""High-quality depth maps for Vathography Studio with Marigold.

The studio estimates depth in the browser (Depth Anything V2). For large
prints you can compute a finer, full-resolution depth map on a computer with
a GPU using Marigold, the diffusion model used in the original vathography
practice, and import it with Depth > Import depth map.

Output: <photo>_depth16.png next to each photo, 16-bit greyscale, white = near,
at the photo's full resolution.

Setup (once):
    pip install torch diffusers transformers accelerate pillow numpy

Usage:
    python marigold_depth.py photo.jpg [more.jpg ...]
    python marigold_depth.py ./folder --ensemble 10 --res 1024
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="photos or folders")
    ap.add_argument("--model", default="prs-eth/marigold-depth-v1-1", help="Hugging Face model id")
    ap.add_argument("--res", type=int, default=1024, help="processing resolution (768 is the training size; higher = more detail, more memory)")
    ap.add_argument("--ensemble", type=int, default=5, help="number of predictions averaged (more = cleaner, slower)")
    ap.add_argument("--steps", type=int, default=4, help="denoising steps")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    from diffusers import MarigoldDepthPipeline

    if torch.cuda.is_available():
        device, dtype, variant = "cuda", torch.float16, "fp16"
    elif torch.backends.mps.is_available():
        device, dtype, variant = "mps", torch.float16, "fp16"
    else:
        device, dtype, variant = "cpu", torch.float32, None
        print("No GPU found: running on the CPU, this will be slow.", file=sys.stderr)

    pipe = MarigoldDepthPipeline.from_pretrained(args.model, variant=variant, torch_dtype=dtype).to(device)

    files = []
    for p in map(Path, args.inputs):
        if p.is_dir():
            files += sorted(f for f in p.iterdir() if f.suffix.lower() in EXTS and not f.stem.endswith("_depth16"))
        elif p.exists():
            files.append(p)
        else:
            print(f"skip: {p} not found", file=sys.stderr)

    for f in files:
        img = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        gen = torch.Generator(device=device).manual_seed(args.seed)
        out = pipe(
            img,
            num_inference_steps=args.steps,
            ensemble_size=args.ensemble,
            processing_resolution=args.res,
            match_input_resolution=True,
            generator=gen,
        )
        depth = np.asarray(out.prediction).squeeze()  # 0 = near … 1 = far
        depth = (depth - depth.min()) / max(1e-9, depth.max() - depth.min())
        near_white = np.round((1.0 - depth) * 65535).astype(np.uint16)
        dst = f.with_name(f.stem + "_depth16.png")
        Image.fromarray(near_white, mode="I;16").save(dst)
        print(f"{f.name} → {dst.name} ({img.width}×{img.height})")


if __name__ == "__main__":
    main()
