// Vision-model cost scales with pixel count, not file size: a 4K screenshot is
// roughly 10,600 image tokens versus ~1,400 at 1400px. Downscaling in the
// browser before upload is the single biggest speed win available, and costs
// nothing at runtime because the canvas API is built in.

// Budget total PIXELS, not the longest edge. Measured on this hardware:
// prefill ran 1095 image tokens in 190s (~5.8 tok/s) for a 0.49MP image, and
// token count tracks pixel count. An edge cap barely touches a tall 1518x1215
// screenshot while over-shrinking a wide 1542x318 one; a pixel budget gives
// both the same predictable cost.
//
// 0.36MP lands around ~800 image tokens (~2 min prefill) while keeping body
// text legible. Lower is faster but starts to cost OCR accuracy.
const MAX_PIXELS = Number(import.meta.env.VITE_IMAGE_MAX_PIXELS || 360000);
// Never upscale, and never blur text by shrinking an already-small image.
const MIN_EDGE = 320;
const JPEG_QUALITY = 0.9;

// Screenshots are typically PNG, which is far larger than JPEG for the same
// visual content, so re-encoding shrinks the upload too.
export async function prepareImage(file) {
  if (!file.type.startsWith('image/')) return { blob: file, resized: false };

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Unsupported/corrupt image — let the backend deal with the original.
    return { blob: file, resized: false };
  }

  const { width, height } = bitmap;
  const pixels = width * height;

  // Scale by area so tall and wide images cost the same to encode.
  let scale = pixels > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / pixels) : 1;

  // Don't shrink a small image into illegibility just to hit the budget.
  const shortest = Math.min(width, height);
  if (shortest * scale < MIN_EDGE) scale = Math.min(1, MIN_EDGE / shortest);

  if (scale >= 1) {
    bitmap.close?.();
    return { blob: file, resized: false, width, height };
  }

  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // A white backdrop stops transparent PNGs turning black once flattened to JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) return { blob: file, resized: false, width, height };

  return {
    blob,
    resized: true,
    from: { width, height, bytes: file.size },
    to: { width: w, height: h, bytes: blob.size },
    // Prefill cost is proportional to pixels, so this ratio is the real speedup.
    pixelReduction: +((width * height) / (w * h)).toFixed(1)
  };
}
