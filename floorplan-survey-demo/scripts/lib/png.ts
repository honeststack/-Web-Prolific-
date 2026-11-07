import { deflateSync, inflateSync } from "node:zlib";

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes an 8-bit grayscale image. */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    raw[row] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), row + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export interface PngCheck {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Fully decodes the file structure, so a truncated or damaged image fails here, not in a participant's browser. */
export function checkPng(buf: Uint8Array): PngCheck {
  const data = Buffer.from(buf);
  if (data.length < 8 || !data.subarray(0, 8).equals(SIGNATURE)) return { ok: false, error: "PNG署名がありません" };
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawEnd = false;
  const idat: Buffer[] = [];
  while (at + 8 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString("ascii", at + 4, at + 8);
    if (at + 12 + length > data.length) return { ok: false, error: `${type}チャンクが途中で切れています` };
    const stored = data.readUInt32BE(at + 8 + length);
    if (crc32(data.subarray(at + 4, at + 8 + length)) !== stored) return { ok: false, error: `${type}チャンクのCRCが不正です` };
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    at += 12 + length;
  }
  if (!width || !height) return { ok: false, error: "IHDRが不正です" };
  if (!sawEnd) return { ok: false, error: "IENDがありません（ファイルが途中で切れています）" };
  if (idat.length === 0) return { ok: false, error: "画像データ（IDAT）がありません" };
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return { ok: false, error: "画像データを展開できません" };
  }
  const channels = CHANNELS[colorType];
  if (!channels) return { ok: false, error: `未対応のカラータイプ ${colorType}` };
  if (!interlace) {
    const expected = (Math.ceil((width * channels * bitDepth) / 8) + 1) * height;
    if (raw.length !== expected) return { ok: false, error: `画像データ長が一致しません（${raw.length} / ${expected}）` };
  }
  return { ok: true, width, height };
}
