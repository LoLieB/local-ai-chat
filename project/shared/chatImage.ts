export type ChatImage = {
  name: string;
  dataUrl: string;
  width: number;
  height: number;
};

export const MAX_CHAT_IMAGE_BYTES = 160 * 1024;
export const IMAGE_CONTEXT_TOKENS = 2048;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function decodeCanonicalBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4) return null;
  const decoded = atob(value);
  if (btoa(decoded) !== value || decoded.length > MAX_CHAT_IMAGE_BYTES) return null;
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function isPngWithDimensions(bytes: Uint8Array, width: number, height: number): boolean {
  if (bytes.length < 8 + 12 + 13 + 12) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  }

  let offset = 8;
  let firstChunk = true;
  let seenIhdr = false;
  let hasImageData = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return false;
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const nextOffset = dataOffset + length + 4;
    if (nextOffset > bytes.length || nextOffset < dataOffset) return false;

    for (let index = typeOffset; index < dataOffset; index += 1) {
      const char = bytes[index];
      if (!((char >= 65 && char <= 90) || (char >= 97 && char <= 122))) return false;
    }

    const isIhdr = bytes[typeOffset] === 73 && bytes[typeOffset + 1] === 72 && bytes[typeOffset + 2] === 68 && bytes[typeOffset + 3] === 82;
    const isIend = bytes[typeOffset] === 73 && bytes[typeOffset + 1] === 69 && bytes[typeOffset + 2] === 78 && bytes[typeOffset + 3] === 68;
    if (isIhdr) {
      if (
        seenIhdr ||
        !firstChunk ||
        length !== 13 ||
        readUint32(bytes, dataOffset) !== width ||
        readUint32(bytes, dataOffset + 4) !== height ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        (bytes[dataOffset + 12] !== 0 && bytes[dataOffset + 12] !== 1)
      ) {
        return false;
      }
      seenIhdr = true;
    } else if (firstChunk) {
      return false;
    }
    if (bytes[typeOffset] === 73 && bytes[typeOffset + 1] === 68 && bytes[typeOffset + 2] === 65 && bytes[typeOffset + 3] === 84 && length > 0) {
      hasImageData = true;
    }
    if (firstChunk) {
      firstChunk = false;
    }
    if (isIend) return length === 0 && hasImageData && nextOffset === bytes.length;
    offset = nextOffset;
  }
  return false;
}

export function validChatImage(value: unknown): value is ChatImage {
  try {
    if (typeof value !== "object" || value === null) return false;
    const image = value as Partial<ChatImage>;
    if (
      typeof image.name !== "string" ||
      image.name.length < 1 ||
      image.name.length > 160 ||
      /[\u0000-\u001f\u007f\\/]/.test(image.name) ||
      typeof image.dataUrl !== "string" ||
      typeof image.width !== "number" ||
      typeof image.height !== "number" ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.width > 1024 ||
      image.height < 1 ||
      image.height > 1024
    ) {
      return false;
    }

    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl);
    if (!match) return false;
    const bytes = decodeCanonicalBase64(match[1]);
    return bytes !== null && isPngWithDimensions(bytes, image.width, image.height);
  } catch {
    return false;
  }
}
