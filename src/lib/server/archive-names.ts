/**
 * File names for downloads. People match a download against their own camera roll by
 * name ("IMG_4411.jpg"), so an item keeps the name it had on the uploader's device
 * whenever that name is known and safe; otherwise it gets a made-up one.
 */

// Extensions that mean the same format; the stored file's own extension wins.
const SAME: Record<string, string> = { jpeg: 'jpg', heif: 'heic', tiff: 'tif', qt: 'mov' };
const canonical = (ext: string) => SAME[ext.toLowerCase()] ?? ext.toLowerCase();
const MEDIA_EXT = /\.(jpe?g|png|webp|gif|avif|hei[cf]|tiff?|mp4|mov|qt|webm|mkv|3gp|m4v)$/i;
// Names Windows refuses whatever their extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * What a device called a file, reduced to something that is safe to write down and to
 * hand back: no folders, no control characters, a sane length. Empty when nothing
 * usable is left.
 */
export function cleanFileName(name: unknown): string {
	if (typeof name !== 'string') return '';
	const base = name.split(/[\\/]/).pop() ?? '';
	return Array.from(base, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

/**
 * The name an item gets in a ZIP or a single download: its original name when there is
 * one, made safe for every operating system and carrying the extension of the file
 * that is actually stored (a video kept only as its mp4 copy is not a `.mov` any more).
 * `fallback` is the name without extension to use when the original is unknown.
 */
export function downloadName(original: string | null, storedExt: string, fallback: string): string {
	const ext = storedExt.toLowerCase();
	let name = cleanFileName(original)
		.replace(/[<>:"|?*]/g, '_')
		.replace(/[. ]+$/, '');
	if (!name || /^\.+$/.test(name)) return `${fallback}.${ext}`;
	const own = MEDIA_EXT.exec(name)?.[1];
	if (own && name.length === own.length + 1) return `${fallback}.${ext}`; // nothing but an extension
	if (own && canonical(own) === canonical(ext)) {
		// Already the right kind of file: keep the name exactly as the camera wrote it.
		return RESERVED.test(name.slice(0, -own.length - 1)) ? `_${name}` : name;
	}
	if (own) name = name.slice(0, -own.length - 1);
	name = name.replace(/[. ]+$/, '').slice(0, 180) || fallback;
	return `${RESERVED.test(name) ? '_' : ''}${name}.${ext}`;
}

/**
 * Hands out names that never repeat within one archive, ignoring case (Windows and
 * macOS would silently overwrite "IMG_0001.jpg" with "img_0001.JPG"): the second
 * "IMG_0001.jpg" in a folder becomes "IMG_0001 (2).jpg".
 */
export function uniqueNames(): (folder: string, name: string) => string {
	const taken = new Set<string>();
	return (folder, name) => {
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : '';
		let candidate = name;
		for (let n = 2; taken.has(`${folder}/${candidate}`.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
		taken.add(`${folder}/${candidate}`.toLowerCase());
		return `${folder}/${candidate}`;
	};
}

/** A `Content-Disposition` value that saves under `name` in every browser, accents included. */
export function attachment(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
