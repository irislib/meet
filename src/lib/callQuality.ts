export type CallQuality = 'auto' | 'high' | 'save' | 'custom'
export interface CallQualitySettings { quality?: CallQuality; customBitrateKbps?: number }
export const callQualityOptions: { value: CallQuality; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'high', label: 'High quality' },
  { value: 'save', label: 'Use less data' },
  { value: 'custom', label: 'Custom' },
]
export function normalizeCallQuality(value: { quality?: unknown; customBitrateKbps?: unknown }): Required<CallQualitySettings> {
  return {
    quality: callQualityOptions.some(option => option.value === value.quality) ? value.quality as CallQuality : 'auto',
    customBitrateKbps: typeof value.customBitrateKbps === 'number' && Number.isFinite(value.customBitrateKbps)
      ? Math.min(8000, Math.max(100, Math.round(value.customBitrateKbps))) : 2000,
  }
}
export function callEncoding(settings: CallQualitySettings) {
  const { quality, customBitrateKbps } = normalizeCallQuality(settings)
  return {
    maxBitrate: quality === 'custom' ? customBitrateKbps * 1000 : { auto: 2_000_000, high: 4_000_000, save: 400_000 }[quality],
    maxFramerate: quality === 'save' ? 20 : 30,
    width: quality === 'high' ? 1920 : quality === 'save' ? 640 : 1280,
    height: quality === 'high' ? 1080 : quality === 'save' ? 360 : 720,
    codec: quality === 'high' ? 'avc1.42e028' : 'avc1.42e01f',
  }
}

/** Preserve camera orientation and aspect ratio; never upscale the captured image. */
export function callVideoFramerate(settings: CallQualitySettings, bitrate = Infinity) {
  return Math.min(callEncoding(settings).maxFramerate, bitrate < 200_000 ? 10 : bitrate < 500_000 ? 15 : 30)
}
export function callVideoSize(settings: CallQualitySettings, capture?: { width?: number; height?: number }, bitrate = Infinity) {
  const quality = callEncoding(settings), width = capture?.width || quality.width, height = capture?.height || quality.height
  const longEdge = Math.min(quality.width, bitrate < 200_000 ? 256 : bitrate < 500_000 ? 480 : bitrate < 1_000_000 ? 960 : quality.width)
  const shortEdge = longEdge * quality.height / quality.width
  const portrait = height > width
  const scale = Math.min(1, (portrait ? shortEdge : longEdge) / width, (portrait ? longEdge : shortEdge) / height)
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2), height: Math.max(2, Math.floor(height * scale / 2) * 2) }
}

/** Layer-specific encoding ceilings for dual-layer simulcast and independent screen sharing. */
export const LAYER_PROFILES = {
  low: { minBitrate: 90_000, defaultBitrate: 180_000, maxBitrate: 260_000, maxWidth: 480, maxHeight: 270, maxFramerate: 15, codec: 'avc1.42e01f' },
  high: { minBitrate: 350_000, defaultBitrate: 1_200_000, maxBitrate: 2_000_000, maxWidth: 1280, maxHeight: 720, maxFramerate: 30, codec: 'avc1.42e01f' },
  screen: { minBitrate: 250_000, defaultBitrate: 1_000_000, maxBitrate: 1_800_000, maxWidth: 1280, maxHeight: 720, maxFramerate: 15, codec: 'avc1.42e01f' },
} as const

export type SimulcastLayerName = keyof typeof LAYER_PROFILES

export function layerVideoGeometry(
  layer: SimulcastLayerName,
  capture: { width?: number; height?: number } | undefined,
  bitrate: number,
): { width: number; height: number; framerate: number; bitrate: number } {
  const profile = LAYER_PROFILES[layer]
  const clamped = Math.max(profile.minBitrate, Math.min(profile.maxBitrate, Math.round(bitrate)))
  const srcW = capture?.width || profile.maxWidth
  const srcH = capture?.height || profile.maxHeight
  let longEdge: number = profile.maxWidth
  let fps: number = profile.maxFramerate
  if (layer === 'low') {
    longEdge = clamped < 130_000 ? 256 : clamped < 180_000 ? 320 : 480
    fps = clamped < 130_000 ? 10 : 15
  } else if (layer === 'high') {
    longEdge = clamped < 500_000 ? 480 : clamped < 950_000 ? 960 : 1280
    fps = clamped < 500_000 ? 15 : 30
  } else {
    longEdge = clamped < 450_000 ? 960 : 1280
    fps = clamped < 450_000 ? 10 : 15
  }
  const shortEdge = longEdge * profile.maxHeight / profile.maxWidth
  const portrait = srcH > srcW
  const scale = Math.min(1, (portrait ? shortEdge : longEdge) / srcW, (portrait ? longEdge : shortEdge) / srcH)
  return {
    width: Math.max(2, Math.floor(srcW * scale / 2) * 2),
    height: Math.max(2, Math.floor(srcH * scale / 2) * 2),
    framerate: fps,
    bitrate: clamped,
  }
}
