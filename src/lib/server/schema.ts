import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import type { VideoQuality } from '#lib/video-quality.js';

/**
 * A User is a registered album *owner*. Guests joining a shared link never need
 * one — accounts exist only so a person can create and manage albums across
 * devices, and so the platform has owners to govern. Identity comes from an
 * OAuth provider (or the dev-login provider), keyed by (provider, providerAccountId).
 */
export const users = pgTable(
	'users',
	{
		id: text('id').primaryKey(),
		provider: text('provider').notNull(),
		providerAccountId: text('provider_account_id').notNull(),
		email: text('email'),
		name: text('name'),
		image: text('image'),
		// Platform admins are provisioned through MIRA_ADMIN_IDENTITIES or the admin UI.
		isAdmin: boolean('is_admin').notNull().default(false),
		// True while admin rights come from MIRA_ADMIN_IDENTITIES; removing the identity
		// from the env revokes them at next sign-in. Admin-UI grants clear this flag.
		adminFromEnv: boolean('admin_from_env').notNull().default(false),
		// Bytes stored across every album this user owns. Maintained by database
		// triggers on photos/albums (initial schema) so quota admission is O(1).
		usedBytes: bigint('used_bytes', { mode: 'number' }).notNull().default(0),
		// Blocked users cannot sign in and lose access to their owner area.
		isBlocked: boolean('is_blocked').notNull().default(false),
		// Per-user storage cap override in MB (null = use the platform default).
		quotaMb: integer('quota_mb'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		unique('users_provider_account').on(t.provider, t.providerAccountId),
		check('users_quota_nonnegative', sql`${t.quotaMb} is null or ${t.quotaMb} >= 0`),
		check('users_used_bytes_nonnegative', sql`${t.usedBytes} >= 0`)
	]
);

/** Single-row table holding platform-wide settings the admin controls. */
export const appSettings = pgTable(
	'app_settings',
	{
		id: integer('id').primaryKey().default(1),
		// How new accounts are gated: 'open' (anyone), 'closed' (none), 'allowlist'.
		registrationMode: text('registration_mode').notNull().default('open'),
		// Comma/newline-separated emails or @domains permitted when mode = allowlist.
		registrationAllowlist: text('registration_allowlist').notNull().default(''),
		// Default per-user storage cap in MB (0 = unlimited).
		defaultQuotaMb: integer('default_quota_mb').notNull().default(10240),
		// Max albums one owner may create (0 = unlimited).
		maxAlbumsPerUser: integer('max_albums_per_user').notNull().default(50),
		// Platform-wide per-file upload limits in MB.
		maxUploadMb: integer('max_upload_mb').notNull().default(40),
		maxVideoMb: integer('max_video_mb').notNull().default(2048),
		// Maintenance switches: pause all uploads / pause new album creation.
		uploadsPaused: boolean('uploads_paused').notNull().default(false),
		albumCreationPaused: boolean('album_creation_paused').notNull().default(false)
	},
	(t) => [
		check('app_settings_singleton', sql`${t.id} = 1`),
		check('app_settings_registration_mode', sql`${t.registrationMode} in ('open', 'closed', 'allowlist')`),
		check('app_settings_default_quota_nonnegative', sql`${t.defaultQuotaMb} >= 0`),
		check('app_settings_max_albums_nonnegative', sql`${t.maxAlbumsPerUser} >= 0`),
		check('app_settings_max_upload_range', sql`${t.maxUploadMb} between 1 and 50`),
		check('app_settings_max_video_range', sql`${t.maxVideoMb} between 1 and 5120`)
	]
);

/** An Album is the shared space friends join. Holds the whole timeline. */
export const albums = pgTable(
	'albums',
	{
		id: text('id').primaryKey(),
		slug: text('slug').notNull().unique(),
		name: text('name').notNull(),
		skin: text('skin').notNull().default('daylight'),
		// accent overrides the skin's accent colour (hex).
		accent: text('accent'),
		// Every album has exactly one account owner. Accounts with albums cannot be
		// deleted until the albums are explicitly deleted or transferred.
		ownerUserId: text('owner_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'restrict' }),
		// Admin takedown: a disabled album is inaccessible to everyone (kept, not deleted).
		disabled: boolean('disabled').notNull().default(false),
		// Album behavior: moderation, and what happens to uploaded videos (see
		// #lib/video-quality). The create form picks the real starting value; this
		// default only keeps a bare insert safe by leaving videos untouched.
		autoApprove: boolean('auto_approve').notNull().default(true),
		videoQuality: text('video_quality').$type<VideoQuality>().notNull().default('original'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('albums_owner_idx').on(t.ownerUserId),
		check('albums_video_quality_check', sql`${t.videoQuality} in ('original', 'lossless', 'balanced', 'small')`)
	]
);

/** A Moment is one ordered segment of the timeline (a place / an occasion). */
export const moments = pgTable(
	'moments',
	{
		id: text('id').primaryKey(),
		albumId: text('album_id')
			.notNull()
			.references(() => albums.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('moments_album_idx').on(t.albumId, t.position)]
);

/** A Member is a person inside one album, identified by their device token. */
export const members = pgTable(
	'members',
	{
		id: text('id').primaryKey(),
		albumId: text('album_id')
			.notNull()
			.references(() => albums.id, { onDelete: 'cascade' }),
		deviceToken: text('device_token').notNull(),
		// When the member is a signed-in user, ties this membership to their account so the
		// SAME account is one identity across devices (null for account-free guests).
		// Account deletion must first retire this membership's browser token. A bare
		// SET NULL would let that browser regain the account's uploads as a guest.
		userId: text('user_id').references(() => users.id, { onDelete: 'restrict' }),
		displayName: text('display_name').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		unique('members_album_device').on(t.albumId, t.deviceToken),
		uniqueIndex('members_album_user_unique')
			.on(t.albumId, t.userId)
			.where(sql`${t.userId} is not null`),
		index('members_device_idx').on(t.deviceToken),
		index('members_user_idx').on(t.albumId, t.userId)
	]
);

/** A media item is an image or video in a moment, uploaded by a member. */
export const photos = pgTable(
	'photos',
	{
		id: text('id').primaryKey(),
		albumId: text('album_id')
			.notNull()
			.references(() => albums.id, { onDelete: 'cascade' }),
		momentId: text('moment_id')
			.notNull()
			.references(() => moments.id, { onDelete: 'cascade' }),
		memberId: text('member_id')
			.notNull()
			.references(() => members.id, { onDelete: 'cascade' }),
		storageKey: text('storage_key').notNull(),
		thumbKey: text('thumb_key').notNull(),
		width: integer('width'),
		height: integer('height'),
		mime: text('mime').notNull(),
		kind: text('kind').notNull().default('image'),
		approved: boolean('approved').notNull().default(true),
		sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
		// True if the server re-encoded this video with ffmpeg.
		optimized: boolean('optimized').notNull().default(false),
		takenAt: timestamp('taken_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('photos_moment_idx').on(t.momentId),
		index('photos_album_idx').on(t.albumId),
		index('photos_member_idx').on(t.memberId),
		index('photos_album_timeline_idx').on(t.albumId, sql`coalesce(${t.takenAt}, ${t.createdAt})`, t.id),
		index('photos_album_visibility_idx').on(t.albumId, t.approved, t.memberId),
		check('photos_kind_check', sql`${t.kind} in ('image', 'video')`),
		check('photos_size_nonnegative', sql`${t.sizeBytes} >= 0`)
	]
);

/** A favorite links a member to a media item they starred. */
export const favorites = pgTable(
	'favorites',
	{
		memberId: text('member_id')
			.notNull()
			.references(() => members.id, { onDelete: 'cascade' }),
		photoId: text('photo_id')
			.notNull()
			.references(() => photos.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.memberId, t.photoId] }), index('favorites_photo_idx').on(t.photoId)]
);

/** Durable state for resumable, bounded video uploads. */
export const uploadSessions = pgTable(
	'upload_sessions',
	{
		id: text('id').primaryKey(),
		albumId: text('album_id')
			.notNull()
			.references(() => albums.id, { onDelete: 'cascade' }),
		momentId: text('moment_id')
			.notNull()
			.references(() => moments.id, { onDelete: 'cascade' }),
		memberId: text('member_id')
			.notNull()
			.references(() => members.id, { onDelete: 'cascade' }),
		deviceToken: text('device_token').notNull(),
		mime: text('mime').notNull(),
		declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
		chunkSize: integer('chunk_size').notNull(),
		totalChunks: integer('total_chunks').notNull(),
		receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
		state: text('state').notNull().default('receiving'),
		mediaItemId: text('media_item_id').references(() => photos.id, { onDelete: 'set null' }),
		approved: boolean('approved').notNull(),
		// The album's video quality when the upload began; a later change to the album
		// does not alter an upload already under way.
		quality: text('quality').$type<VideoQuality>().notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('upload_sessions_expiry_idx').on(t.expiresAt),
		index('upload_sessions_member_idx').on(t.memberId),
		index('upload_sessions_album_state_idx').on(t.albumId, t.state),
		uniqueIndex('upload_sessions_media_item_unique').on(t.mediaItemId),
		check('upload_sessions_state_check', sql`${t.state} in ('receiving', 'completing', 'complete', 'failed')`),
		check('upload_sessions_declared_bytes_positive', sql`${t.declaredBytes} > 0`),
		check('upload_sessions_quality_check', sql`${t.quality} in ('original', 'lossless', 'balanced', 'small')`),
		check('upload_sessions_chunk_size_positive', sql`${t.chunkSize} > 0`),
		check('upload_sessions_total_chunks_positive', sql`${t.totalChunks} > 0`),
		check('upload_sessions_received_bytes_nonnegative', sql`${t.receivedBytes} >= 0`)
	]
);

export type Album = typeof albums.$inferSelect;
/** A receipt and byte accounting commit together; filesystem existence is not a receipt. */
export const uploadChunks = pgTable(
	'upload_chunks',
	{
		uploadId: text('upload_id')
			.notNull()
			.references(() => uploadSessions.id, { onDelete: 'cascade' }),
		index: integer('chunk_index').notNull(),
		bytes: integer('bytes').notNull(),
		digest: text('digest').notNull()
	},
	(t) => [primaryKey({ columns: [t.uploadId, t.index] })]
);

/** Committed deletion intent survives a process crash; intentionally has no cascading FK. */
export const mediaDeletions = pgTable('media_deletions', {
	id: text('id').primaryKey(),
	ownerId: text('owner_id').notNull(),
	kind: text('kind').notNull(),
	key: text('key').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export type Moment = typeof moments.$inferSelect;
export type Member = typeof members.$inferSelect;
export type MediaItem = typeof photos.$inferSelect;
export type User = typeof users.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
