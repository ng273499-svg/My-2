import type {
  VisionBinaryDiagnostics,
  VisionFrameSubmission,
} from '@/core/types';

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function computeGeometry(width?: number, height?: number): Pick<
  VisionBinaryDiagnostics,
  'width' | 'height' | 'aspectRatio' | 'orientation' | 'megapixels'
> {
  if (!width || !height || width <= 0 || height <= 0) {
    return {};
  }
  const divisor = gcd(width, height);
  const rw = Math.round(width / divisor);
  const rh = Math.round(height / divisor);
  const aspectRatio =
    rw <= 64 && rh <= 64
      ? `${rw}:${rh}`
      : `${(width / height).toFixed(2)}:1`;
  const orientation =
    Math.abs(width - height) <= Math.max(2, Math.round(width * 0.02))
      ? 'square'
      : width > height
        ? 'landscape'
        : 'portrait';
  const megapixels = Number(((width * height) / 1_000_000).toFixed(3));

  return {
    width,
    height,
    aspectRatio,
    orientation,
    megapixels,
  };
}

export function decodeBase64ImageBytes(base64OrDataUrl: string): Uint8Array {
  const cleaned = base64OrDataUrl.includes(',')
    ? base64OrDataUrl.slice(base64OrDataUrl.indexOf(',') + 1).trim()
    : base64OrDataUrl.trim();

  if (!cleaned) return new Uint8Array(0);
  // Cap inspection buffer safely at 4 MB
  const bounded = cleaned.slice(0, 5_600_000);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(bounded, 'base64'));
  }
  const bin = atob(bounded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Deterministic Zero-Dependency Image Binary & SVG Header Inspector.
 * Extracts genuine verified format, pixel dimensions (`width` x `height`), aspect ratio,
 * orientation, and SVG text labels without fabricating semantic scene descriptions.
 */
export function inspectImageBinaryPayload(
  frame: Pick<VisionFrameSubmission, 'mimeType' | 'width' | 'height' | 'base64Data'>,
  rawBytes?: Uint8Array
): VisionBinaryDiagnostics {
  const bytes =
    rawBytes ??
    (frame.base64Data ? decodeBase64ImageBytes(frame.base64Data) : new Uint8Array(0));

  if (bytes.length === 0) {
    return {
      verifiedFormat: 'unknown',
      bytesInspected: 0,
      ...computeGeometry(frame.width, frame.height),
    };
  }

  // 1. PNG (`89 50 4E 47 0D 0A 1A 0A` + `IHDR` at offset 16..23)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    return {
      verifiedFormat: 'png',
      bytesInspected: bytes.length,
      ...computeGeometry(width, height),
    };
  }

  // 2. GIF (`GIF87a` / `GIF89a` -> little-endian uint16 width/height at offset 6..9)
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    return {
      verifiedFormat: 'gif',
      bytesInspected: bytes.length,
      ...computeGeometry(width, height),
    };
  }

  // 3. JPEG (`FF D8` -> scan markers for SOF0/SOF1/SOF2 `FF C0..C3`)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      // SOF0, SOF1, SOF2, SOF3
      if (marker >= 0xc0 && marker <= 0xc3) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return {
          verifiedFormat: 'jpeg',
          bytesInspected: bytes.length,
          ...computeGeometry(width, height),
        };
      }
      const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return {
      verifiedFormat: 'jpeg',
      bytesInspected: bytes.length,
      ...computeGeometry(frame.width, frame.height),
    };
  }

  // 4. WebP (`RIFF....WEBP`)
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunkTag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    let width: number | undefined;
    let height: number | undefined;
    if (chunkTag === 'VP8X') {
      width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    } else if (chunkTag === 'VP8L') {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    }
    return {
      verifiedFormat: 'webp',
      bytesInspected: bytes.length,
      ...computeGeometry(width ?? frame.width, height ?? frame.height),
    };
  }

  // 5. SVG XML vector graphics (`<svg ...>`)
  const textHead = new TextDecoder('utf-8', { fatal: false }).decode(
    bytes.slice(0, Math.min(bytes.length, 32_768))
  );
  if (/<svg[\s>]/i.test(textHead)) {
    let width = frame.width;
    let height = frame.height;
    const viewBoxMatch = textHead.match(
      /viewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i
    );
    if (viewBoxMatch) {
      width = Math.round(Number(viewBoxMatch[1]));
      height = Math.round(Number(viewBoxMatch[2]));
    } else {
      const wMatch = textHead.match(/\bwidth=["']([0-9.]+)/i);
      const hMatch = textHead.match(/\bheight=["']([0-9.]+)/i);
      if (wMatch && hMatch) {
        width = Math.round(Number(wMatch[1]));
        height = Math.round(Number(hMatch[1]));
      }
    }

    const svgTextLabels: string[] = [];
    const textRegex = /<(?:text|title)[^>]*>([^<]{1,120})<\/(?:text|title)>/gi;
    let m: RegExpExecArray | null = textRegex.exec(textHead);
    while (m && svgTextLabels.length < 10) {
      const clean = m[1].trim();
      if (clean) svgTextLabels.push(clean);
      m = textRegex.exec(textHead);
    }

    return {
      verifiedFormat: 'svg',
      bytesInspected: bytes.length,
      svgTextLabels: svgTextLabels.length > 0 ? svgTextLabels : undefined,
      ...computeGeometry(width, height),
    };
  }

  return {
    verifiedFormat: 'unknown',
    bytesInspected: bytes.length,
    ...computeGeometry(frame.width, frame.height),
  };
}
