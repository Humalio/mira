import { describe, expect, it } from 'vitest';
import { eligibleDeviceMembership, isAlbumOwner } from './guard';
import type { Member } from './schema';

const locals = (deviceToken: string, userId?: string) => ({
	deviceToken,
	auth: async () => (userId ? { user: { id: userId } } : null)
});

describe('eligibleDeviceMembership', () => {
	const base = { id: 'member', albumId: 'album', deviceToken: 'device', displayName: 'A', createdAt: new Date() };
	it('refuses an account-linked member after logout or account switching', () => {
		const linked = { ...base, userId: 'account-a' } as Member;
		expect(eligibleDeviceMembership(linked)).toBeUndefined();
	});
	it('allows an unlinked guest member returned by a device lookup', () => {
		const guest = { ...base, userId: null } as Member;
		expect(eligibleDeviceMembership(guest)).toBe(guest);
		expect(eligibleDeviceMembership(undefined)).toBeUndefined();
	});
});

describe('isAlbumOwner', () => {
	it('recognises an account owner on a different device', async () => {
		await expect(isAlbumOwner({ ownerUserId: 'owner' }, locals('new-device', 'owner'))).resolves.toBe(true);
	});

	it('does not grant owner permissions from a device token', async () => {
		await expect(isAlbumOwner({ ownerUserId: 'owner' }, locals('original-device'))).resolves.toBe(false);
	});
});
