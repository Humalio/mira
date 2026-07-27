import { error } from '@sveltejs/kit';

export const LIMITS = {
	albumName: 120,
	momentName: 120,
	displayName: 80,
	allowlist: 20_000,
	originalFilename: 200,
	jsonBytes: 16 * 1024,
	formBytes: 64 * 1024,
	posterBytes: 2 * 1024 * 1024,
	imageBytes: 50 * 1024 * 1024,
	// A photo may have this many pixels. Phones now take 48 and 50 megapixel photos, so
	// 40 refused real pictures. 64 covers them and stays within what the server can hold:
	// two photos are processed at a time (see concurrency.ts), and the worst case, an
	// image that has to be decoded whole (four bytes a pixel), is then about 256 MB each.
	imagePixels: 64_000_000,
	// A video poster is a single frame the browser captured; it never needs more.
	posterPixels: 40_000_000,
	videoBytes: 5 * 1024 * 1024 * 1024,
	chunkBytes: 16 * 1024 * 1024,
	selectedMedia: 250
} as const;

export function requiredText(value: unknown, field: string, maxLength: number): string {
	const text = String(value ?? '').trim();
	if (!text) throw error(400, `${field} is required`);
	if (text.length > maxLength) throw error(400, `${field} must be ${maxLength} characters or fewer`);
	return text;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requiredUuid(value: unknown, field: string): string {
	const id = requiredText(value, field, 36);
	if (!UUID_PATTERN.test(id)) throw error(400, `${field} is invalid`);
	return id;
}

export function optionalText(value: unknown, field: string, maxLength: number): string {
	const text = String(value ?? '').trim();
	if (text.length > maxLength) throw error(400, `${field} must be ${maxLength} characters or fewer`);
	return text;
}

export function boundedInteger(value: unknown, field: string, min: number, max: number): number {
	const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw error(400, `${field} must be an integer between ${min} and ${max}`);
	}
	return parsed;
}

export function requireContentLength(request: Request, maxBytes: number): void {
	const raw = request.headers.get('content-length');
	if (!raw) throw error(411, 'Content-Length is required');
	const length = Number(raw);
	if (!Number.isSafeInteger(length) || length < 0) throw error(400, 'Invalid Content-Length');
	if (length > maxBytes) throw error(413, 'Request body is too large');
}

export function jsonObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, 'Expected a JSON object');
	return value as Record<string, unknown>;
}
