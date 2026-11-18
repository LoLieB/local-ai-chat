import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CHAT_IMAGE_BYTES, validChatImage } from "../../shared/chatImage.ts";

function chunk(type: string, data: number[]): number[] {
  const length = data.length;
  return [length >>> 24, (length >>> 16) & 255, (length >>> 8) & 255, length & 255, ...[...type].map((char) => char.charCodeAt(0)), ...data, 0, 0, 0, 0];
}

function png(width = 1, height = 1, options: { includeIdat?: boolean; repeatedIhdr?: boolean } = {}): string {
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", [width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255, height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255, 8, 6, 0, 0, 0])];
  if (options.repeatedIhdr) bytes.push(...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
  if (options.includeIdat !== false) bytes.push(...chunk("IDAT", [0]));
  bytes.push(...chunk("IEND", []));
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function image(dataUrl = png()) {
  return { name: "picture.png", dataUrl, width: 1, height: 1 };
}

test("accepts a canonical PNG data URL with matching dimensions", () => {
  assert.equal(validChatImage(image()), true);
});

test("rejects dimensions spoofed outside the PNG IHDR", () => {
  assert.equal(validChatImage({ ...image(), width: 2 }), false);
});

test("rejects malformed and non-canonical base64", () => {
  assert.equal(validChatImage(image("data:image/png;base64,@@@=")), false);
  assert.equal(validChatImage(image("data:image/png;base64,iA==")), false);
});

test("rejects truncated PNG chunks and unsafe filenames", () => {
  const truncated = image().dataUrl.slice(0, -4);
  assert.equal(validChatImage(image(truncated)), false);
  assert.equal(validChatImage({ ...image(), name: "../picture.png" }), false);
  assert.equal(validChatImage({ ...image(), name: "line\nbreak.png" }), false);
});

test("rejects PNGs without image data or with repeated IHDR", () => {
  assert.equal(validChatImage(image(png(1, 1, { includeIdat: false }))), false);
  assert.equal(validChatImage(image(png(1, 1, { repeatedIhdr: true }))), false);
});

test("rejects a payload larger than the byte limit", () => {
  const encodedLength = Math.ceil((MAX_CHAT_IMAGE_BYTES + 1) / 3) * 4;
  const dataUrl = `data:image/png;base64,${"A".repeat(encodedLength)}`;
  assert.equal(validChatImage(image(dataUrl)), false);
});
