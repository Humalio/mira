# Mira changelog

## [Unreleased]

### Features

- A new look, "Shared Frame": a connected-m logo and app icon, and plum, grape and apricot colours on a paper background, in the app and on the project website. Albums on the default look take it on; the earlier sand look stays available as "Sand", and a dark "Plum" look is added.
- Six interface languages: English (UK), Spanish (Spain), German, French, Portuguese (Portugal) and Italian.
- Manually triggered GitHub Docker releases for Intel/AMD Linux, with versioned images and installation files.

- Album owners choose a video quality per album: original, almost lossless, balanced or small. Compression shows its progress, waits its turn instead of being skipped, survives dropped connections and server restarts, and produces video that plays on every device. This changes the day-zero database schema: a database created by an earlier build needs to be replaced by a fresh one.

- Videos keep their untouched original beside the small copy the album plays. Download and every ZIP give the original; the viewer shows both sizes. "Save space: keep only the small copy" is a separate per-album opt-in, and videos compressed by earlier builds are labelled as reduced copies. New albums start with a "Small" playback copy. No database change.

- An open album keeps itself current: new and newly approved items appear without a reload, and a video that is still uploading or being compressed shows to everyone as a placeholder tile ("Marta’s video is being prepared"). The page asks the server every ten seconds, and not at all while its tab is hidden. A guest whose upload needs approval is told so in plain words.

- For events: a printable QR card, closing an album (nothing new can be added; still viewable and downloadable), and resetting the invitation link so the old link and QR code stop letting people in.
- A guest with a new phone or a cleared browser can be let back in as themselves with a one-time link from the album's owner, instead of joining again under a second name.
- New installations start with registration closed; the sign-in and join pages say who runs the copy and link to a plain privacy page (`MIRA_OPERATOR_NAME`, `MIRA_OPERATOR_CONTACT`, `MIRA_RETENTION_NOTE`).
- Sign in with an administrator password (`MIRA_ADMIN_PASSWORD`), so a new installation needs no application registered with Google or GitHub. The hosting guide installs from the published image with one Compose file. A refused sign-in now returns to the sign-in page with an explanation instead of an error page.
- Downloads keep original file names; the viewer shows when and where an item was taken; pasted invitation links get a preview.

- When a video exists in both sizes, the person downloading chooses: full quality or the smaller file, for one video in the viewer or for every video in a ZIP.

### Fixes

- Adding Mira to a phone's home screen uses its name, colours and icons: the app manifest is now linked from every page.
- `PUBLIC_ORIGIN` now takes effect: invitation links, QR codes, the printable card, return links and link previews use it instead of the address the request arrived on.
- Self-hosted fonts and OAuth redirects work with the application security policy.
- A photo's retry key can no longer be aimed at somebody else's media: a guest could remove another guest's video while it was being prepared.
- Video uploads that were abandoned no longer keep an account "full" for a day; only uploads that are under way hold the storage they declared.
- A fully uploaded video is no longer discarded by a failure that may pass (not enough free disk at that moment, a busy database): its pieces are kept and it is tried again. A video waiting its turn is finished by the server even if its uploader closed the page or the phone went to sleep.
- Removing a large album no longer makes the same owner's other uploads fail while its files are deleted.
- An album settings file that cannot be read closes that album and its invitation until it reads again, instead of silently reopening both.
- A video still being prepared survives its uploader being let back in with a return link.
- Removing the administrator password no longer leaves registration closed with nobody able to sign in.
- A stopping server keeps its single-instance lock until the video it is working on is finished.
- The language switch only ever returns to a page on this site.
- Photos up to 64 megapixels are accepted (48 and 50 megapixel phone photos were refused); a larger one is refused with its own message.
- A video that was let start is no longer refused at the end because photos filled the space it had reserved meanwhile.
- A ZIP download that is cancelled closes the file it was reading, so repeated cancelled downloads cannot exhaust the server's open files.
- An unknown album look can no longer be saved and break the album's pages; an admin limit out of range says which setting is wrong.
- A video piece sent without its number is refused instead of being taken as the first piece.
