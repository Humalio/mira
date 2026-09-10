// Draws static/invite.png, the picture chat apps show beside a pasted invitation link.
// It deliberately contains no album content and no words: the link's title and
// description carry the album's name in the reader's language, and a private photo
// must never end up in a preview that anyone holding the link can fetch.
//
//   node scripts/make-invite-image.mjs
import sharp from 'sharp';

const W = 1200;
const H = 630;
const print = (x, y, w, h, turn, fill) => `
	<g transform="rotate(${turn} ${x + w / 2} ${y + h / 2})">
		<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#fffefb" />
		<rect x="${x + 16}" y="${y + 16}" width="${w - 32}" height="${h - 74}" rx="10" fill="${fill}" />
	</g>`;
// Shared Frame palette: plum, grape, apricot and wash on the paper canvas.
const paper = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
	<rect width="${W}" height="${H}" fill="#f8f5ef" />
	<g opacity="0.95" filter="drop-shadow(0 10px 18px rgba(56,36,61,0.16))">
		${print(120, 150, 300, 330, -9, '#f3b99c')}
		${print(780, 150, 300, 330, 8, '#38243d')}
		${print(330, 96, 250, 280, 5, '#694b75')}
		${print(640, 250, 250, 280, -6, '#eee6f0')}
	</g>
	<circle cx="${W / 2}" cy="${H / 2}" r="178" fill="#f8f5ef" />
</svg>`);
const icon = await sharp(new URL('../static/icons/icon-512.png', import.meta.url).pathname)
	.resize(280, 280)
	.ensureAlpha()
	// Keep the tile's rounded shape (radius 112 of 512) even if the file is a full square.
	.composite([
		{
			input: Buffer.from('<svg width="280" height="280"><rect width="280" height="280" rx="61" /></svg>'),
			blend: 'dest-in'
		}
	])
	.png()
	.toBuffer();
await sharp(paper)
	.composite([{ input: icon, left: (W - 280) / 2, top: (H - 280) / 2 }])
	.png({ compressionLevel: 9 })
	.toFile(new URL('../static/invite.png', import.meta.url).pathname);
console.log('wrote static/invite.png');
