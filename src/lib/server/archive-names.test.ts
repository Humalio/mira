import { describe, expect, it } from 'vitest';
import { attachment, cleanFileName, downloadName, uniqueNames } from './archive-names';

describe('cleanFileName', () => {
	it('keeps an ordinary camera name, accents and all', () => {
		expect(cleanFileName('IMG_4411.JPG')).toBe('IMG_4411.JPG');
		expect(cleanFileName('Cumpleaños Ana.jpg')).toBe('Cumpleaños Ana.jpg');
	});
	it('drops folders, control characters and absurd lengths', () => {
		expect(cleanFileName('../../etc/passwd')).toBe('passwd');
		expect(cleanFileName('C:\\Users\\ana\\DCIM\\IMG_1.jpg')).toBe('IMG_1.jpg');
		expect(cleanFileName('a\u0000b\nc.jpg')).toBe('a b c.jpg');
		expect(cleanFileName('x'.repeat(500)).length).toBe(200);
		expect(cleanFileName(undefined)).toBe('');
		expect(cleanFileName('   ')).toBe('');
	});
});

describe('downloadName', () => {
	it('gives back the original name when the stored file is that kind of file', () => {
		expect(downloadName('IMG_4411.JPG', 'jpg', 'Marta-001')).toBe('IMG_4411.JPG');
		expect(downloadName('IMG_4411.jpeg', 'jpg', 'Marta-001')).toBe('IMG_4411.jpeg');
		expect(downloadName('clip.MOV', 'mov', 'Marta-001')).toBe('clip.MOV');
	});
	it('carries the stored extension when the file is no longer what its name says', () => {
		// A video kept only as its mp4 copy, a HEIC that was named .jpg, a name with no extension.
		expect(downloadName('IMG_0090.MOV', 'mp4', 'Marta-001')).toBe('IMG_0090.mp4');
		expect(downloadName('photo.jpg', 'heic', 'Marta-001')).toBe('photo.heic');
		expect(downloadName('holiday', 'jpg', 'Marta-001')).toBe('holiday.jpg');
		expect(downloadName('notes.v2', 'png', 'Marta-001')).toBe('notes.v2.png');
	});
	it('falls back to a made-up name when the original is unknown or unusable', () => {
		expect(downloadName(null, 'jpg', 'Marta-001')).toBe('Marta-001.jpg');
		expect(downloadName('...', 'jpg', 'Marta-001')).toBe('Marta-001.jpg');
		expect(downloadName('.jpg', 'jpg', 'Marta-001')).toBe('Marta-001.jpg');
	});
	it('never produces a name an operating system refuses', () => {
		expect(downloadName('what?<really>*.jpg', 'jpg', 'f')).toBe('what__really__.jpg');
		expect(downloadName('con.jpg', 'jpg', 'f')).toBe('_con.jpg');
		expect(downloadName('NUL', 'png', 'f')).toBe('_NUL.png');
		expect(downloadName('a/b\\c.jpg', 'jpg', 'f')).toBe('c.jpg');
		expect(downloadName('trailing. .jpg. ', 'jpg', 'f')).toBe('trailing. .jpg');
	});
});

describe('uniqueNames', () => {
	it('numbers namesakes apart within a folder, ignoring case', () => {
		const unique = uniqueNames();
		expect(unique('Day_1', 'IMG_0001.jpg')).toBe('Day_1/IMG_0001.jpg');
		expect(unique('Day_1', 'IMG_0001.jpg')).toBe('Day_1/IMG_0001 (2).jpg');
		expect(unique('Day_1', 'img_0001.JPG')).toBe('Day_1/img_0001 (3).JPG');
		// Someone really has a file called "IMG_0001 (2).jpg": it must not collide either.
		expect(unique('Day_1', 'IMG_0001 (2).jpg')).toBe('Day_1/IMG_0001 (2) (2).jpg');
		expect(unique('Day_2', 'IMG_0001.jpg')).toBe('Day_2/IMG_0001.jpg');
	});
});

describe('attachment', () => {
	it('offers a plain name and the real one', () => {
		expect(attachment('Cumpleaños "Ana".jpg')).toBe(
			`attachment; filename="Cumplea_os _Ana_.jpg"; filename*=UTF-8''Cumplea%C3%B1os%20%22Ana%22.jpg`
		);
	});
});
