/**
 * What an album does with the videos uploaded to it. The uploaded file is always kept
 * untouched (unless the owner turns on "keep only the small copy", see
 * `#lib/server/album-options.js`); this choice is about the COPY the album plays from.
 * The owner chooses per album; the value is stored in `albums.video_quality` and copied
 * onto each upload when it starts.
 *
 * - `original`  no copy: the album plays the uploaded file itself
 * - `lossless`  same picture size, practically indistinguishable, saves little space
 * - `balanced`  same picture size, detail loss hard to spot, usually under half the size
 * - `small`     picture reduced to 720p and compressed harder (1 GB to under 100 MB)
 *
 * Keep the list in step with the two CHECK constraints in database/schema.sql.
 */
export const VIDEO_QUALITIES = ['original', 'lossless', 'balanced', 'small'] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/**
 * What the "New album" form starts on. The owner can change it there and later.
 * "small" because the original is kept anyway: the copy only has to start fast.
 */
export const DEFAULT_VIDEO_QUALITY: VideoQuality = 'small';

export const isVideoQuality = (value: unknown): value is VideoQuality =>
	typeof value === 'string' && (VIDEO_QUALITIES as readonly string[]).includes(value);
