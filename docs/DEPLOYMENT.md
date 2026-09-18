# Deploying Mira

Run one instance behind an HTTPS reverse proxy. You need Docker Compose v2 and disk
space for a PostgreSQL database and the media. Nothing has to be built, and no
application has to be registered with a sign-in service.

## First installation

Make an empty folder and put two files in it.

1. `compose.yaml`: a copy of [`deploy/compose.prod.yaml`](../deploy/compose.prod.yaml)
   (also attached to every release, and shown in full on the project site's hosting
   page).
2. `.env`, with your own values:

```sh
# The exact address people will type, scheme included.
ORIGIN=https://photos.example.org
# Two long random values. Make each with:  openssl rand -hex 32
POSTGRES_PASSWORD=
AUTH_SECRET=
# Your sign-in password: at least 12 characters.
MIRA_ADMIN_PASSWORD=
```

Then:

```sh
docker compose up -d
```

Forward HTTPS traffic to `127.0.0.1:5180`, open your address and sign in with the
password. The database is set up on the first start.

| Setting                 | What it is                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ORIGIN`                | The address in the browser's address bar, exactly, scheme and port included, no path. Form posts (joining an album, signing in) from any other host name or port are rejected. |
| `PUBLIC_ORIGIN`         | The address written into invitation links and QR codes. Defaults to `ORIGIN`.                                                                                                  |
| `MIRA_IMAGE`            | The release to run. Defaults to the version named in the Compose file. Pin a version from the releases page; there is no `latest` tag. See [releases](RELEASES.md).            |
| `MIRA_PORT`             | The port on `127.0.0.1` that Mira is published on (default 5180). Your proxy forwards to it; the container is not reachable from the network directly.                         |
| `POSTGRES_PASSWORD`     | Password of the bundled database. URL-safe characters only (`openssl rand -hex 32`).                                                                                           |
| `AUTH_SECRET`           | At least 32 random characters. Signs sessions and guest return links; changing it signs everyone out.                                                                          |
| `MIRA_ADMIN_PASSWORD`   | The administrator password for the sign-in page (see "Signing in").                                                                                                            |
| `MIRA_ADMIN_IDENTITIES` | Instead of, or as well as, the password: exact accounts at a sign-in service that are administrators, such as `github:123456`.                                                 |
| `MIRA_OPERATOR_*`       | Who runs this copy, shown to guests (see "Administration and privacy").                                                                                                        |

To try Mira on the computer you are sitting at, without a domain or HTTPS, set
`ORIGIN=http://localhost:5180` and open that address after `docker compose up -d`.

### Building the image yourself

The Compose file runs the published image of this version,
`ghcr.io/humalio/mira:0.1.0`. Until that release is published on the
[releases page](https://github.com/Humalio/mira/releases), or to run your own changes,
build the image from a clone of this repository instead:

```sh
git clone https://github.com/Humalio/mira.git
cd mira
docker build -t mira:local .
```

Write the `.env` above in the clone's root folder, add `MIRA_IMAGE=mira:local`, and
start the same Compose file from there:

```sh
docker compose --env-file .env -f deploy/compose.prod.yaml up -d
```

Configure the proxy to forward client addresses and match `ADDRESS_HEADER` /
`XFF_DEPTH` to the trusted proxy chain. Do not expose the container directly when
trusting forwarded headers.

The Compose file uses named volumes for PostgreSQL and `/data`; media lives at
`/data/media`, and video uploads in progress are staged beside it in `/data/.uploads`
(always the folder next to `MEDIA_DIR`, so keep both on the same disk). `MEDIA_DIR` and `DATABASE_URL` in the environment example are for
local Node execution; Compose ignores both and builds the database address from
`POSTGRES_*`. Host bind mounts are optional customization and must be writable by
uid 1000. Keep credentials out of Git.

## Signing in

Guests never sign in. Owners, who create albums, do, in one of two ways.

**An administrator password.** Set `MIRA_ADMIN_PASSWORD` (12 characters or more) and
the sign-in page shows a password field. Whoever knows the password is the one local
account, an administrator; `MIRA_ADMIN_NAME` sets the name it is shown under. Nothing
is stored in the database: the password is read from the environment and compared in
constant time. What you give up compared with a sign-in service: there is no second
factor and no "forgot password" (change the variable and recreate the container);
after ten wrong tries the password sign-in pauses for five minutes for everyone, the
right password included, so someone who keeps guessing can keep you out of that login
while they do (albums and guests are unaffected); and the password sits in `.env`
beside the other secrets. Changing or removing it signs that account out everywhere.
Use a long password that you use nowhere else. If you remove the password to move to
a sign-in service, name your account there in `MIRA_ADMIN_IDENTITIES` at the same
time: the password account stops counting as this copy's administrator, and "closed"
registration only applies while there is one.

**A sign-in service**, for other people who should own albums, or instead of the
password. Set both ID and secret for at least one provider in `.env`:
`AUTH_GOOGLE_*`, `AUTH_GITHUB_*`, or `AUTH_FACEBOOK_*`, and register the callback
`https://YOUR_DOMAIN/auth/callback/google` (or `github` / `facebook`) with that
provider. Name the administrators among them in `MIRA_ADMIN_IDENTITIES` as exact
provider account identities such as `github:123456`; there is no first-user admin
fallback. GitHub exposes the account ID as `id` in
`https://api.github.com/users/YOUR_USERNAME`. Never enable development
authentication in production.

The two can be combined. Each sign-in is its own account, and an album belongs to the
account that created it: if you start with the password and later move to a sign-in
service, keep the password until the albums you want are recreated or no longer
needed, because albums cannot yet be handed from one account to another.

Facebook sign-in is kept deliberately for now and is a candidate for removal in a
later release. Removing it would mean: dropping the Facebook provider from
`src/auth.ts`, the `AUTH_FACEBOOK_*` variables from `.env.example` and
`deploy/compose.prod.yaml`, the two Facebook `form-action` origins from the content
security policy in `vite.config.ts`, and the mentions in this guide and
`site/hosting.html`. Accounts that only ever signed in with Facebook would then
need another provider, so check for them first.

## Administration and privacy

Owner accounts create albums. Guests with invitation links can join without an
account. Anyone receiving a forwarded invitation can join.

**Who can become an owner.** A new installation starts with registration **closed**:
only the administrators named in `MIRA_ADMIN_IDENTITIES` can sign in, and nobody
who merely finds the address gets an account. To let others create albums, open
registration or list their emails or `@domains` under Admin, Settings, Registration.
An installation set up before this default keeps the setting it has stored (the old
default was open); check it once in the admin settings. With no administrator
configured and none in the database, "closed" is not enforced, because nobody could
ever open it again.

**Tell guests whose server this is.** Someone opening an invitation is about to put
photos on a server they know nothing about. Set these, and the sign-in page, the join
page and `/privacy` say it in your words:

| Variable                | Example                                        |
| ----------------------- | ---------------------------------------------- |
| `MIRA_OPERATOR_NAME`    | `Ana Etxeberria`                               |
| `MIRA_OPERATOR_CONTACT` | `ana@example.org` or an `https://` page        |
| `MIRA_RETENTION_NOTE`   | `Albums are deleted one year after the event.` |

All three are optional. Without them the pages say that this is a private copy run
by whoever sent the link, and that photos stay until they are deleted. `/privacy`
describes what the software itself keeps and who can see it; it is not legal advice
and does not replace a privacy notice you may owe your guests under local law.

Photos are stored and downloaded as untouched originals, byte for byte, with all
embedded metadata, including the capture time and EXIF/GPS location. This is a
deliberate product decision, not an oversight: sharing originals is what Mira is
for, so nothing strips or re-encodes them. The join page tells guests so. Only the
small thumbnails are re-encoded, without that metadata. Album members can download
originals, so share invitation links with people you would share the location of
your photos with.

A photo may be up to 64 megapixels (and up to the image size limit in the admin UI),
which covers the 48 and 50 megapixel photos of current phones. A larger one is refused
with a message saying so; nothing is stored.

Administrators are provisioned through `MIRA_ADMIN_IDENTITIES` or the admin UI.
Removing an env-provisioned identity revokes its rights at its next sign-in unless
it is the last active administrator. UI grants are independent of removal from
the environment. Upload size, account quota, and registration settings live in the
admin UI.

## Albums for an event

What an owner can do around a party, a wedding or a trip, from the album itself:

- **Print a QR card.** "Invite friends", then "Print a QR card": the album's name, a
  large QR code and one line of instructions, laid out for printing. Any member can
  open it.
- **Close the album.** Album menu, "Close the album" (or the album's settings on the
  home page). Nothing new can be added by anyone; everyone can still look, favourite
  and download. "Reopen the album" undoes it. An upload already under way when the
  album is closed is allowed to finish.
- **Reset the invitation link.** "Invite friends", then "Reset the invitation link".
  The link and QR code handed out before stop letting new people in; everyone already
  in the album stays. Print a new card afterwards. People who should not have joined
  are not removed by this.
- **Let a guest back in.** A guest is recognised by a cookie, so a new phone or a
  cleared browser is a stranger and would have to join again under a second name.
  Album menu, "Let someone back in", pick the guest, and send them the link shown. It
  works once, within 24 hours, and moves that guest (name, uploads, favourites) to the
  device that opens it; if that device had already joined again, the duplicate is
  folded into the original. A guest can do the same for themselves before switching
  phones ("Move to another device", valid 15 minutes). Whoever opens a valid link
  becomes that guest, so send it to the right person. People with an account never
  need this: they sign in.

These settings have no database column (the day-zero schema cannot change under
existing installations). "Closed" and the reset invitation are stored in `album.json`
in the album's folder on the media volume; a return link is a signed, expiring token
made with `AUTH_SECRET`, so changing that secret cancels every outstanding link.
If an `album.json` exists but cannot be read (a disk error, damaged content), Mira
does not guess: until it reads again that album takes nothing new, nobody can join it
through any link, its owner cannot change these settings, and the server log says
`[album-options] unreadable`. Looking and downloading still work. Restore the file
from your backup, or delete it to return the album to open with its plain link.

## Video compression

Videos are the large part of any album: a clip from a phone is often around 1 GB.
Mira keeps every uploaded video **untouched**, exactly as it keeps photos, and can
make a smaller **copy for playback** beside it. The album plays the copy, so a video
starts at once even on a slow connection; "Download" in the viewer and every ZIP
(whole album, by person, favourites, a selection) give the original, byte for byte,
with its recording date and location. The viewer shows both sizes, for example
"Original 1.03 GB · plays from a 42 MB copy".

Each album's owner chooses the copy:

| Copy for playback   | What the server does                                                     | What to expect                                                                      |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Small (recommended) | Reduces the picture to 720p, upright or sideways alike, and x264 CRF 28. | A 1 GB clip typically plays from a copy under 100 MB.                               |
| Balanced            | Re-encodes at the same picture size (x264 CRF 23).                       | Differences are hard to spot. The copy is usually less than half the size.          |
| Almost lossless     | Re-encodes at the same picture size, keeping nearly all detail (CRF 18). | Practically identical. Saves little, often nothing (then no copy is kept); slowest. |
| No copy             | Nothing. The album plays the uploaded file itself.                       | Big clips start slowly; some phone formats do not play in every browser.            |

A copy is an H.264/AAC mp4 in 8-bit so it plays on every device, with the recording
date and location tags carried over. No copy is kept when ffmpeg is unavailable,
fails, or would not make a smaller file; the original then plays as it is. Photos are
never touched (see above). The size figures are guidance, not measurements on real
footage.

- **The person downloading chooses.** When a video exists in both sizes, Download in
  the viewer asks "Full quality" or "Smaller file" and shows the size of each, and
  the ZIP download sheet has the same choice for all videos at once. Full quality is
  the starting choice. Photos, and videos that have no copy, always come as uploaded.
- **What it costs.** Keeping both means a video occupies its original size plus the
  copy: about 1.05 GB for a 1 GB clip with a "Small" copy. Storage use, the per-account
  quota and the admin totals count both files. If an owner's quota has room for the
  original but not for the copy as well, the copy is dropped and the original kept.
- **Save space: keep only the small copy.** A separate per-album switch, off by
  default, for owners who cannot afford the disk. With it on, the original is deleted
  as soon as its copy exists; downloads then give the copy, the viewer labels the video
  "Reduced copy — the original was not kept", and the join page tells guests that
  videos are kept as smaller copies. Nothing brings a deleted original back.
- **Videos from before originals were kept.** A video compressed by an earlier build
  has no original any more. It keeps working and is labelled "Reduced copy — the
  original was not kept" in the viewer.
- **Where the choice is.** Per album, under "Videos": in the "New album" sheet, and
  afterwards under the cog next to the album on the home page. There is no
  instance-wide setting and no environment variable.
- **Default.** The "New album" form starts on "Small", with originals kept. A change
  applies to videos uploaded afterwards; videos already in the album stay as they are.
- **Where it is stored.** The copy choice is the `albums.video_quality` column. The
  "save space" switch has no column (the day-zero schema cannot change under existing
  installations): it lives in `album.json` in the album's folder on the media volume,
  which is backed up with the media. Inside a video's folder, `orig.<ext>` is the
  upload and `opt.mp4` the copy.
- **What it needs.** `ffmpeg` and `ffprobe` on the server's PATH. The published image
  includes both. Without them videos are stored as uploaded, with no copy, and nothing
  fails.
- **Size and time.** The admin setting "video size limit" caps one upload (2048 MB by
  default, 5120 at most). Uploads go up in 12 MB pieces, so a proxy body limit of
  16 MB or more is enough. One video is compressed at a time and others wait their
  turn; the uploader sees "waiting", then a percentage. Two videos are put together
  at once; a third waits for one of them and is then started by the server itself. As a guide, on a four-core
  machine a 1 GB full-HD clip of eight minutes took about five minutes. An encode is
  stopped only if it exceeds ten minutes plus one minute per 25 MB, two hours at most.
- **Disk.** From first piece to finished file a video needs free space for about
  three times its size, plus 512 MB, on the media volume (the uploaded pieces, the
  assembled original and the copy exist together for a while; afterwards the original
  and the copy remain). A video is refused before
  its upload starts, with a message saying so, when that room is not there.
- **What the others see.** While a video is uploading, being put together or being
  compressed, every member of the album sees a placeholder tile for it, and an open
  album page picks up finished and newly approved items by itself. The page asks the
  server every ten seconds (every four while a video is on its way) and stops while
  its tab is hidden, so a room full of open phones is a handful of small requests.
- **Interruptions.** A dropped connection during upload is retried for up to ten
  minutes and continues where it stopped. Once the upload is complete the uploader can
  close the page, also while the video is still waiting its turn. If the server
  restarts during compression, it starts that video again by itself from the uploaded
  pieces. A failure that may pass (not enough free disk at that moment, a busy
  database) does not cost the video: its pieces are kept and the server tries again
  after a minute, then at growing intervals up to half an hour, for at most 48 hours
  after the upload began; the log says `finalisation will be retried`. Only a video
  that is over the storage or size limit, or whose pieces are gone, is given up.
  Uploads abandoned half-way are removed 24 hours after their last piece arrived. After
  30 minutes without a piece they stop holding the owner's storage limit for the part
  that never arrived.

## Day-zero setup and backups

This is Mira **0.1.0**, the first release. On first startup,
`scripts/init-db.mjs` creates the complete schema from `database/schema.sql`
in one transaction. Subsequent starts recognize the same schema and leave data
unchanged. Setup refuses an occupied database from an earlier development build;
there is no upgrade or backfill path in this release. Use a fresh database for
this release. No setup command deletes existing data.

Back up PostgreSQL and the media volume together, including the durable
file-deletion queue. Test restoration before relying on a backup. File deletions
are queued transactionally and retried by maintenance, normally within five minutes.

Configuration changes require container recreation; replacing only the image does
not refresh environment variables.
Run exactly one server per database. A PostgreSQL advisory lock enforces this;
a replacement waits up to 90 seconds for the previous process to stop. Losing the
lock connection terminates the server. Allow 120 seconds for container shutdown: a
stopping server keeps the lock until the video it is putting together is finished (or
the container is killed), so a replacement never starts on that video's files while
the old process is still writing them.
Video finalizations interrupted by a restart are run again automatically on startup.

## Release checks and website

`sh scripts/verify-release.sh` validates the source, every database test, dependency
audit, fresh and repeat database initialization, and production image startup using disposable
containers. No test database ports are published. It does not test real OAuth callbacks.

The static website lives in `site/`. To deploy it, choose **GitHub Actions** under
repository **Settings → Pages**, then run **Publish Mira website**. Pages hosts
only the introduction and hosting guide, not the application.

## Versioned GitHub images

Download `compose.yaml` and `environment.example` from a published GitHub Release into one folder. Save the example as `.env`, fill in the required values, and select that release's image version. The Compose file pulls the prebuilt image; Node, Python and build tools are unnecessary on your server.

The source repository also provides `deploy/compose.prod.yaml`. From its root run:

```sh
docker compose --env-file .env -f deploy/compose.prod.yaml pull
docker compose --env-file .env -f deploy/compose.prod.yaml up -d --no-build
```

Ports bind to localhost. Keep the app behind a trusted reverse proxy and the access controls described above. Named volumes preserve data. Optional external integrations still need their own credentials; no credentials are baked into images.
