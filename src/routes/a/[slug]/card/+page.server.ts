import { inviteUrl } from '#lib/server/invite.js';
import QRCode from 'qrcode';
import type { PageServerLoad } from './$types';

/** A card to print and put on the table: the album's name and its invitation as a QR code. */
export const load: PageServerLoad = async ({ parent, url }) => {
	const { album } = await parent(); // the layout has already checked membership
	const joinUrl = await inviteUrl(album.slug, url);
	return {
		albumName: album.name,
		joinUrl,
		// Large and with the strongest error correction: it will be photographed at an
		// angle, in bad light, off a wrinkled sheet.
		qr: await QRCode.toDataURL(joinUrl, { margin: 2, width: 900, errorCorrectionLevel: 'H' })
	};
};
