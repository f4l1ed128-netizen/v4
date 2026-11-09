// Existing V1/V2 subscriptions default to streams only. New YouTube and TikTok subscriptions can monitor both.
export const MAX_SEEN_UPLOADS = 75;
export const supportsVideoUploads = platform => ['youtube', 'tiktok'].includes(platform);
export function normalizeUploadMode(platform, value) {
  if (!supportsVideoUploads(platform)) return 'streams';
  return ['streams', 'videos', 'both'].includes(value) ? value : 'streams';
}
// Keep the old name available for compatibility with V2 integrations.
export const normalizeYouTubeMode = normalizeUploadMode;
export function newUploadVideos(videos, seenIds = []) {
  const seen = new Set(seenIds);
  return videos.filter(v => v?.id && !seen.has(v.id))
    .sort((a, b) => String(a.publishedAt || '').localeCompare(String(b.publishedAt || '')));
}
