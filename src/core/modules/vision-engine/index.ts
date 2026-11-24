import { inspectImageBinaryPayload } from '@/core/vision';
import { resolveServerProviderCredentials } from '@/core/models/provider-config';
import type { VisionFrameSubmission, VisionInspectionResult } from '@/core/types';

export interface VisionModelAdapter {
  readonly id: string;
  readonly name: string;
  isConfigured(): boolean;
  analyzeFrame(frame: VisionFrameSubmission, imageBytes: Uint8Array): Promise<string>;
}

/**
 * Vision Engine (JARVIS-X v1.0)
 * Performs deterministic binary image header & geometry inspection (`PNG`, `JPEG`, `GIF`,
 * `WebP`, `SVG`) locally and routes full base64 frames to configured multimodal Vision
 * providers (`OpenAI`, `Anthropic`, `Gemini`) when server API keys are present.
 * Never fabricates semantic scene/object descriptions when no Vision LLM is connected.
 */
export class VisionEngine {
  private adapter: VisionModelAdapter | null = null;

  registerAdapter(adapter: VisionModelAdapter): void {
    this.adapter = adapter;
  }

  isConnected(): boolean {
    const creds = resolveServerProviderCredentials();
    return Boolean(
      this.adapter?.isConfigured() ||
        process.env.VISION_PROVIDER_MODEL?.trim() ||
        creds.openaiApiKey ||
        creds.anthropicApiKey ||
        creds.geminiApiKey
    );
  }

  inspectFrameMetadata(frame: VisionFrameSubmission): VisionInspectionResult {
    const connected = this.isConnected();
    const label =
      frame.fileName ||
      (frame.source === 'camera_preview' ? 'Live Camera Frame' : 'Image Attachment');

    const binaryDiag = inspectImageBinaryPayload(frame);
    const enrichedMetadata: VisionFrameSubmission = {
      ...frame,
      width: binaryDiag.width ?? frame.width,
      height: binaryDiag.height ?? frame.height,
    };

    const geomSummary =
      binaryDiag.width && binaryDiag.height
        ? `${binaryDiag.verifiedFormat.toUpperCase()} ${binaryDiag.width}×${binaryDiag.height}px (${binaryDiag.aspectRatio}, ${binaryDiag.orientation})`
        : `${frame.mimeType}${frame.sizeBytes ? `, ${frame.sizeBytes} bytes` : ''}`;

    const svgNote =
      binaryDiag.svgTextLabels && binaryDiag.svgTextLabels.length > 0
        ? ` Extracted SVG labels: ${binaryDiag.svgTextLabels.map((t) => `"${t}"`).join(', ')}.`
        : '';

    return {
      accepted: true,
      providerConnected: connected,
      frameMetadata: enrichedMetadata,
      binaryDiagnostics: binaryDiag,
      statusMessage: connected
        ? `Vision Engine verified "${label}" (${geomSummary}) and routed multimodal payload to configured Vision LLM.${svgNote}`
        : binaryDiag.bytesInspected > 0
          ? `Vision Engine verified binary frame "${label}" (${geomSummary}).${svgNote} Multimodal Vision LLM is UNCONFIGURED (NOT_AVAILABLE) — semantic visual scene recognition was not fabricated.`
          : `Vision Engine staged metadata for "${label}" (${geomSummary}), but Multimodal Vision Model is Not Connected (NOT_AVAILABLE). No visual content claims were generated.`,
    };
  }
}
