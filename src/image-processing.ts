import { LUCK_PHOTO } from "../shared/profile";

export interface DecodedPhoto {
  image: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  close: () => void;
}

/** The original photo picker uses from-image decoding so iPhone EXIF rotation
 * is applied before measuring, scaling or selecting the crop rectangle. */
export async function loadPhoto(file: Blob): Promise<DecodedPhoto> {
  if (!/^image\//.test(file.type)) throw new Error("사진 파일만 고를 수 있어요.");
  if (file.size > 30 * 1024 * 1024) throw new Error("사진이 너무 커요. 30MB 이하로 골라 주세요.");
  if (typeof createImageBitmap === "function") {
    try {
      const image = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (!image.width || !image.height) { image.close(); throw new Error("빈 사진이에요."); }
      return { image, width: image.width, height: image.height, close: () => image.close() };
    } catch { /* Image elements also respect EXIF on supported browsers. */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("사진을 읽지 못했어요. 다른 사진을 골라 주세요."));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("사진을 읽지 못했어요.");
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export function photoCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이 브라우저에서 사진을 편집할 수 없어요.");
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#FFF9EE";
  context.fillRect(0, 0, width, height);
  return { canvas, context };
}

/** A strict byte check also catches browsers that silently fall back to PNG. */
export function encodePhoto(canvas: HTMLCanvasElement, maxBytes: number): string {
  for (const mime of ["image/webp", "image/jpeg"]) {
    for (const quality of [.86, .78, .7, .6, .5, .4, .3, .2, .12]) {
      let url: string;
      try { url = canvas.toDataURL(mime, quality); } catch { break; }
      if (!url.startsWith(`data:${mime};base64,`)) break;
      const base64 = url.slice(url.indexOf(",") + 1);
      const bytes = base64.length * 3 / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
      if (bytes <= maxBytes) return url;
    }
  }
  throw new Error("사진을 저장할 크기로 줄이지 못했어요. 다른 사진을 골라 주세요.");
}

/** Evidence photos preserve the full image and aspect ratio; no square crop. */
export async function shrinkPhoto(file: File | Blob): Promise<string> {
  const photo = await loadPhoto(file);
  try {
    const ratio = Math.min(1, LUCK_PHOTO.maxSide / Math.max(photo.width, photo.height));
    const width = Math.max(1, Math.round(photo.width * ratio));
    const height = Math.max(1, Math.round(photo.height * ratio));
    const { canvas, context } = photoCanvas(width, height);
    context.drawImage(photo.image, 0, 0, width, height);
    return encodePhoto(canvas, LUCK_PHOTO.maxBytes);
  } finally { photo.close(); }
}
