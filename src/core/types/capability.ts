import type { PermissionTier } from './permission';

export type CapabilityConnectionState =
  | 'connected_local'
  | 'interface_ready_not_connected'
  | 'browser_dependent';

export type CapabilityCategory =
  | 'voice_stt'
  | 'voice_tts'
  | 'voice_barge_in'
  | 'vision_camera'
  | 'web_research'
  | 'file_analysis'
  | 'computer_actions'
  | 'code_execution'
  | 'external_apis'
  | 'smart_home_devices'
  | 'notifications'
  | 'proactive_tasks'
  | 'cross_device_sync'
  | 'internal_diagnostics';

export interface ToolCapabilityDescriptor {
  id: string;
  name: string;
  category: CapabilityCategory;
  state: CapabilityConnectionState;
  permissionTier: PermissionTier;
  description: string;
  statusDetail: string;
  requiredIntegration?: string;
}

export interface VisionFrameSubmission {
  fileName?: string;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  base64Data?: string;
  source: 'upload' | 'camera_preview';
  userPrompt?: string;
}

export interface VisionBinaryDiagnostics {
  verifiedFormat: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'unknown';
  width?: number;
  height?: number;
  aspectRatio?: string;
  orientation?: 'landscape' | 'portrait' | 'square';
  megapixels?: number;
  svgTextLabels?: string[];
  bytesInspected: number;
}

export interface VisionInspectionResult {
  accepted: boolean;
  providerConnected: boolean;
  statusMessage: string;
  frameMetadata: VisionFrameSubmission;
  binaryDiagnostics?: VisionBinaryDiagnostics;
}

export interface ProactiveAdvisory {
  id: string;
  title: string;
  summary: string;
  priority: 'info' | 'attention';
  category: 'system' | 'memory' | 'schedule_interface';
  createdAt: string;
}
