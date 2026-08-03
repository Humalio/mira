/**
 * Where a photo or video was taken, read from the original file on request.
 *
 * Mira keeps every original with its metadata, so the place is already there; it is
 * simply not in the database. The viewer asks for it when someone opens an item.
 * Nothing leaves the server: the answer is two numbers, and it is the viewer who
 * decides whether to open them on a map.
 */
import { execFile } from 'node:child_process';
import exifr from 'exifr';
import { mediaAbsPath } from './storage';

export type Place = { lat: number; lon: number };

const known = new Map<string, Place | null>();

/** Coordinates that can exist and are not the "not set" value some cameras write. */
export function validPlace(lat: unknown, lon: unknown): Place | null {
	if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
	return { lat, lon };
}

/** A video container's location tag, e.g. `+43.3183-001.9812/` or `+43.3183-001.9812+012.300/`. */
export function parseIso6709(tag: string): Place | null {
	const m = /^\s*([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(tag);
	return m ? validPlace(Number(m[1]), Number(m[2])) : null;
}

function videoLocationTag(abs: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			'ffprobe',
			[
				...['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm'],
				...['-show_entries', 'format_tags=location,com.apple.quicktime.location.ISO6709'],
				...['-of', 'default=nw=1:nk=1', abs]
			],
			{ timeout: 20_000, maxBuffer: 64 * 1024 },
			(failure, out) => resolve(failure ? '' : String(out))
		);
	});
}

/** The place recorded in an item's file, or null when it has none (or cannot be read). */
export async function placeOf(item: { id: string; kind: string; storageKey: string }): Promise<Place | null> {
	if (known.has(item.id)) return known.get(item.id) ?? null;
	let place: Place | null = null;
	const abs = mediaAbsPath(item.storageKey);
	if (abs) {
		try {
			if (item.kind === 'video') {
				for (const line of (await videoLocationTag(abs)).split(/\r?\n/)) place ??= parseIso6709(line);
			} else {
				const gps = await exifr.gps(abs);
				place = validPlace(gps?.latitude, gps?.longitude);
			}
		} catch {
			/* no metadata, or a format exifr cannot read: there is simply no place to show */
		}
	}
	if (known.size > 5_000) known.clear();
	known.set(item.id, place);
	return place;
}
