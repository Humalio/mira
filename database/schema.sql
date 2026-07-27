-- Mira day-zero schema. Fresh installations only.
CREATE FUNCTION public.mira_album_bytes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
	album_bytes bigint;
BEGIN
	SELECT coalesce(sum("size_bytes"), 0) INTO album_bytes FROM "photos" WHERE "album_id" = OLD."id";
	UPDATE "users" SET "used_bytes" = "used_bytes" - album_bytes WHERE "id" = OLD."owner_user_id";
	IF TG_OP = 'UPDATE' THEN
		UPDATE "users" SET "used_bytes" = "used_bytes" + album_bytes WHERE "id" = NEW."owner_user_id";
		RETURN NEW;
	END IF;
	RETURN OLD;
END;
$$;

CREATE FUNCTION public.mira_photo_bytes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		-- When the album itself is being deleted its rows are already gone here; the
		-- albums BEFORE DELETE trigger has subtracted the whole album at once.
		UPDATE "users" u SET "used_bytes" = u."used_bytes" - OLD."size_bytes"
		FROM "albums" a WHERE a."id" = OLD."album_id" AND u."id" = a."owner_user_id";
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		UPDATE "users" u SET "used_bytes" = u."used_bytes" + NEW."size_bytes"
		FROM "albums" a WHERE a."id" = NEW."album_id" AND u."id" = a."owner_user_id";
	END IF;
	RETURN NULL;
END;
$$;

CREATE TABLE public.albums (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    skin text DEFAULT 'daylight'::text NOT NULL,
    accent text,
    auto_approve boolean DEFAULT true NOT NULL,
    video_quality text DEFAULT 'original'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    CONSTRAINT albums_video_quality_check CHECK ((video_quality = ANY (ARRAY['original'::text, 'lossless'::text, 'balanced'::text, 'small'::text])))
);

CREATE TABLE public.app_settings (
    id integer DEFAULT 1 NOT NULL,
    registration_mode text DEFAULT 'open'::text NOT NULL,
    registration_allowlist text DEFAULT ''::text NOT NULL,
    default_quota_mb integer DEFAULT 10240 NOT NULL,
    max_albums_per_user integer DEFAULT 50 NOT NULL,
    max_upload_mb integer DEFAULT 40 NOT NULL,
    max_video_mb integer DEFAULT 2048 NOT NULL,
    uploads_paused boolean DEFAULT false NOT NULL,
    album_creation_paused boolean DEFAULT false NOT NULL,
    CONSTRAINT app_settings_default_quota_nonnegative CHECK ((default_quota_mb >= 0)),
    CONSTRAINT app_settings_max_albums_nonnegative CHECK ((max_albums_per_user >= 0)),
    CONSTRAINT app_settings_max_upload_range CHECK (((max_upload_mb >= 1) AND (max_upload_mb <= 50))),
    CONSTRAINT app_settings_max_video_range CHECK (((max_video_mb >= 1) AND (max_video_mb <= 5120))),
    CONSTRAINT app_settings_registration_mode CHECK ((registration_mode = ANY (ARRAY['open'::text, 'closed'::text, 'allowlist'::text]))),
    CONSTRAINT app_settings_singleton CHECK ((id = 1))
);

CREATE TABLE public.favorites (
    member_id text NOT NULL,
    photo_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.media_deletions (
    id text NOT NULL,
    owner_id text NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.members (
    id text NOT NULL,
    album_id text NOT NULL,
    device_token text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id text
);

CREATE TABLE public.moments (
    id text NOT NULL,
    album_id text NOT NULL,
    name text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.photos (
    id text NOT NULL,
    album_id text NOT NULL,
    moment_id text NOT NULL,
    member_id text NOT NULL,
    storage_key text NOT NULL,
    thumb_key text NOT NULL,
    width integer,
    height integer,
    mime text NOT NULL,
    kind text DEFAULT 'image'::text NOT NULL,
    approved boolean DEFAULT true NOT NULL,
    size_bytes bigint NOT NULL,
    taken_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    optimized boolean DEFAULT false NOT NULL,
    CONSTRAINT photos_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text]))),
    CONSTRAINT photos_size_nonnegative CHECK ((size_bytes >= 0))
);

CREATE TABLE public.upload_chunks (
    upload_id text NOT NULL,
    chunk_index integer NOT NULL,
    bytes integer NOT NULL,
    digest text NOT NULL
);

CREATE TABLE public.upload_sessions (
    id text NOT NULL,
    album_id text NOT NULL,
    moment_id text NOT NULL,
    member_id text NOT NULL,
    device_token text NOT NULL,
    mime text NOT NULL,
    declared_bytes bigint NOT NULL,
    chunk_size integer NOT NULL,
    total_chunks integer NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'receiving'::text NOT NULL,
    media_item_id text,
    approved boolean NOT NULL,
    quality text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT upload_sessions_chunk_size_positive CHECK ((chunk_size > 0)),
    CONSTRAINT upload_sessions_declared_bytes_positive CHECK ((declared_bytes > 0)),
    CONSTRAINT upload_sessions_quality_check CHECK ((quality = ANY (ARRAY['original'::text, 'lossless'::text, 'balanced'::text, 'small'::text]))),
    CONSTRAINT upload_sessions_received_bytes_nonnegative CHECK ((received_bytes >= 0)),
    CONSTRAINT upload_sessions_state_check CHECK ((state = ANY (ARRAY['receiving'::text, 'completing'::text, 'complete'::text, 'failed'::text]))),
    CONSTRAINT upload_sessions_total_chunks_positive CHECK ((total_chunks > 0))
);

CREATE TABLE public.users (
    id text NOT NULL,
    provider text NOT NULL,
    provider_account_id text NOT NULL,
    email text,
    name text,
    image text,
    is_admin boolean DEFAULT false NOT NULL,
    is_blocked boolean DEFAULT false NOT NULL,
    quota_mb integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    admin_from_env boolean DEFAULT false NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    CONSTRAINT users_quota_nonnegative CHECK (((quota_mb IS NULL) OR (quota_mb >= 0))),
    CONSTRAINT users_used_bytes_nonnegative CHECK ((used_bytes >= 0))
);

ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_slug_unique UNIQUE (slug);

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_member_id_photo_id_pk PRIMARY KEY (member_id, photo_id);

ALTER TABLE ONLY public.media_deletions
    ADD CONSTRAINT media_deletions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_album_device UNIQUE (album_id, device_token);

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.moments
    ADD CONSTRAINT moments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.upload_chunks
    ADD CONSTRAINT upload_chunks_upload_id_chunk_index_pk PRIMARY KEY (upload_id, chunk_index);

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_provider_account UNIQUE (provider, provider_account_id);

CREATE INDEX albums_owner_idx ON public.albums USING btree (owner_user_id);

CREATE INDEX favorites_photo_idx ON public.favorites USING btree (photo_id);

CREATE UNIQUE INDEX members_album_user_unique ON public.members USING btree (album_id, user_id) WHERE (user_id IS NOT NULL);

CREATE INDEX members_device_idx ON public.members USING btree (device_token);

CREATE INDEX members_user_idx ON public.members USING btree (album_id, user_id);

CREATE INDEX moments_album_idx ON public.moments USING btree (album_id, "position");

CREATE INDEX photos_album_idx ON public.photos USING btree (album_id);

CREATE INDEX photos_album_timeline_idx ON public.photos USING btree (album_id, COALESCE(taken_at, created_at), id);

CREATE INDEX photos_album_visibility_idx ON public.photos USING btree (album_id, approved, member_id);

CREATE INDEX photos_member_idx ON public.photos USING btree (member_id);

CREATE INDEX photos_moment_idx ON public.photos USING btree (moment_id);

CREATE INDEX upload_sessions_album_state_idx ON public.upload_sessions USING btree (album_id, state);

CREATE INDEX upload_sessions_expiry_idx ON public.upload_sessions USING btree (expires_at);

CREATE UNIQUE INDEX upload_sessions_media_item_unique ON public.upload_sessions USING btree (media_item_id);

CREATE INDEX upload_sessions_member_idx ON public.upload_sessions USING btree (member_id);

CREATE TRIGGER albums_used_bytes_delete BEFORE DELETE ON public.albums FOR EACH ROW EXECUTE FUNCTION public.mira_album_bytes();

CREATE TRIGGER albums_used_bytes_owner BEFORE UPDATE OF owner_user_id ON public.albums FOR EACH ROW WHEN ((old.owner_user_id IS DISTINCT FROM new.owner_user_id)) EXECUTE FUNCTION public.mira_album_bytes();

CREATE TRIGGER photos_used_bytes AFTER INSERT OR DELETE OR UPDATE OF size_bytes, album_id ON public.photos FOR EACH ROW EXECUTE FUNCTION public.mira_photo_bytes();

ALTER TABLE ONLY public.albums
    ADD CONSTRAINT albums_owner_user_id_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_member_id_members_id_fk FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_photo_id_photos_id_fk FOREIGN KEY (photo_id) REFERENCES public.photos(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_album_id_albums_id_fk FOREIGN KEY (album_id) REFERENCES public.albums(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.moments
    ADD CONSTRAINT moments_album_id_albums_id_fk FOREIGN KEY (album_id) REFERENCES public.albums(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_album_id_albums_id_fk FOREIGN KEY (album_id) REFERENCES public.albums(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_member_id_members_id_fk FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.photos
    ADD CONSTRAINT photos_moment_id_moments_id_fk FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.upload_chunks
    ADD CONSTRAINT upload_chunks_upload_id_upload_sessions_id_fk FOREIGN KEY (upload_id) REFERENCES public.upload_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_album_id_albums_id_fk FOREIGN KEY (album_id) REFERENCES public.albums(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_media_item_id_photos_id_fk FOREIGN KEY (media_item_id) REFERENCES public.photos(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_member_id_members_id_fk FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_moment_id_moments_id_fk FOREIGN KEY (moment_id) REFERENCES public.moments(id) ON DELETE CASCADE;
