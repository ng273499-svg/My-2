'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Aperture,
  Camera,
  ImagePlus,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import type { StagedVisionAttachment } from './MultimodalInputBar';

interface VisionInspectorModalProps {
  open: boolean;
  cloudVisionConnected?: boolean;
  onClose: () => void;
  onStageAttachment: (attachment: StagedVisionAttachment) => void;
}

export function VisionInspectorModal({
  open,
  cloudVisionConnected = false,
  onClose,
  onStageAttachment,
}: VisionInspectorModalProps) {
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraNotice, setCameraNotice] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  };

  useEffect(() => {
    if (!open) {
      stopCamera();
      setCameraNotice(null);
    }
    return () => stopCamera();
  }, [open]);

  if (!open) return null;

  const handleToggleCamera = async () => {
    if (cameraActive) {
      stopCamera();
      return;
    }

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraNotice('Browser mediaDevices API is unavailable in this environment.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      setCameraActive(true);
      setCameraNotice(null);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      });
    } catch {
      setCameraNotice('Camera permission declined or no camera hardware detected.');
    }
  };

  const handleCaptureCameraFrame = () => {
    const video = videoRef.current;
    if (!video) return;
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    onStageAttachment({
      fileName: `camera-frame-${Date.now()}.png`,
      mimeType: 'image/png',
      sizeBytes: Math.round((dataUrl.length * 3) / 4),
      width,
      height,
      base64Data: dataUrl,
      source: 'camera_preview',
    });
    stopCamera();
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size <= 3_000_000 && typeof FileReader !== 'undefined') {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : undefined;
        onStageAttachment({
          fileName: file.name,
          mimeType: file.type || 'image/png',
          sizeBytes: file.size,
          base64Data: dataUrl,
          source: 'upload',
        });
        onClose();
      };
      reader.onerror = () => {
        onStageAttachment({
          fileName: file.name,
          mimeType: file.type || 'image/png',
          sizeBytes: file.size,
          source: 'upload',
        });
        onClose();
      };
      reader.readAsDataURL(file);
      return;
    }

    onStageAttachment({
      fileName: file.name,
      mimeType: file.type || 'image/png',
      sizeBytes: file.size,
      source: 'upload',
    });
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Vision Engine Interface Inspector"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div className="glass-panel w-full max-w-lg p-5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-cyan-300" />
            <h2 className="font-display text-base font-semibold text-slate-100">
              Vision Engine Interface
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Vision Inspector"
            className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Honest Multimodal Status Banner */}
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-cyan-400/25 bg-cyan-950/25 p-3 text-xs text-cyan-100">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <div>
            <div className="font-mono font-semibold uppercase tracking-wider text-cyan-200">
              {cloudVisionConnected
                ? 'Multimodal Vision LLM: Connected · Binary Frame Inspector Active'
                : 'Multimodal Vision LLM: Not Connected · Binary Frame Inspector Active'}
            </div>
            <p className="mt-1 leading-relaxed text-slate-300">
              <code className="font-mono text-cyan-200">VisionEngine</code> verifies exact PNG/JPEG/GIF/WebP/SVG dimensions, aspect ratios, and SVG labels locally, and forwards base64 frames to multimodal Vision LLMs when configured on the server — never fabricating scene content.
            </p>
          </div>
        </div>

        {/* Camera Preview Test Box */}
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/80 p-3">
          {cameraActive ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-44 w-full rounded-lg bg-black object-cover"
            />
          ) : (
            <div className="flex h-32 flex-col items-center justify-center text-center text-xs text-slate-500">
              <Video className="mb-1.5 h-6 w-6 text-slate-600" />
              <span>Local camera stream off (explicit opt-in only)</span>
            </div>
          )}

          {cameraNotice && (
            <p className="mt-2 font-mono text-[11px] text-rose-300">{cameraNotice}</p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleToggleCamera}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3.5 text-xs font-medium text-slate-200 transition hover:border-cyan-400/40"
            >
              {cameraActive ? (
                <>
                  <VideoOff className="h-4 w-4 text-rose-300" />
                  Stop Camera
                </>
              ) : (
                <>
                  <Video className="h-4 w-4 text-cyan-300" />
                  Test Local Camera Hardware
                </>
              )}
            </button>

            {cameraActive && (
              <button
                type="button"
                onClick={handleCaptureCameraFrame}
                aria-label="Capture live camera frame"
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-emerald-400/40 bg-emerald-500/15 px-3.5 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/25"
              >
                <Aperture className="h-4 w-4" />
                Capture Frame
              </button>
            )}
          </div>

          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-4 text-xs font-medium text-cyan-100 transition hover:bg-cyan-500/25">
            <ImagePlus className="h-4 w-4" />
            Stage Image Frame
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
