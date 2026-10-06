import { createHash } from "node:crypto";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_BATCH_SIZE = 8;
const imageTypes = new Set(["image", "image_url", "input_image"]);
export const isImageBlock = (value) => value && typeof value === "object" && imageTypes.has(value.type);
export function validateImage(block) {
  const data = block.data ?? block.image_url?.url ?? block.image_url;
  if (typeof data !== "string" || !data) throw new Error("Invalid image data");
  const encoded = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  if (/^https?:\/\//.test(data)) return block;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid image base64");
  const decodedBytes =
    Math.floor((encoded.length * 3) / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (decodedBytes > MAX_IMAGE_BYTES) throw new Error("Each image must be at most 10 MB");
  return block;
}
export function imageId(image) {
  validateImage(image);
  return createHash("sha256")
    .update(image.mimeType ?? "")
    .update(image.data ?? JSON.stringify(image.image_url))
    .digest("hex");
}
/** Media is preserved on the wire; only the application's text estimate omits it. */
export function textBudgetValue(value) {
  if (isImageBlock(value)) {
    validateImage(value);
    return undefined;
  }
  if (Array.isArray(value)) return value.map(textBudgetValue).filter((item) => item !== undefined);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, textBudgetValue(item)]));
  return value;
}
export function imageBatches(images) {
  images.forEach(validateImage);
  return Array.from({ length: Math.ceil(images.length / IMAGE_BATCH_SIZE) }, (_, index) =>
    images.slice(index * IMAGE_BATCH_SIZE, (index + 1) * IMAGE_BATCH_SIZE),
  );
}
