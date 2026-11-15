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
- Photo uploads no longer hang on a connection that goes silent, and one photo that cannot be sent no longer stops the rest of the batch or the videos after it.
- Removing the administrator password and later `MIRA_ADMIN_IDENTITIES` can no longer leave an installation with no administrator and registration open: the old password account no longer counts as an administrator once its sign-in is off.
- A video upload that resumes after a long pause is checked against the storage limit again, instead of being refused only after every piece was sent.
- A photo retried near the storage limit no longer removes the files of the copy that was already saved.
- Slow phones no longer hold the server's processing places while their files are still arriving, so other people's uploads are not turned away.
- An open album stays on the page being read when new items arrive. Closing or reopening it, resetting its invitation and changing its video settings now reach pages that are already open.
- A refused action in the album's sheets (adding a moment, renaming, a return link) says why instead of doing nothing.
- A return link works once, even if its guest later goes back to an earlier phone. Someone signed in to an account who opens a guest's return link is told so and the link stays usable. Links made before this version stop working.
- Taking administrator rights from an account named in `MIRA_ADMIN_IDENTITIES`, or from the password account, is refused with an explanation, since the next sign-in would restore them.
- Large videos on slow disks get time to be put together; a database hiccup while a video is being finished no longer discards it; a busy encoder no longer leaves a video without its playback copy; and uploads waiting to retry no longer hold up newer ones.
- AVIF photos are kept, shown and downloaded as AVIF. Ones added earlier stay labelled HEIC.
- Download names with apostrophes or brackets keep their accented letters in Firefox.
- After someone signs out of a shared browser, the next person can no longer cancel or affect that account's video uploads.
- Starting a video upload is retried like its pieces and never leaves a second, empty upload behind; a video the phone gives no type for is recognised by its file extension; and paused uploads are reported at once instead of after minutes of retrying.
- Sharing on a slow connection asks for a second tap once the files are ready instead of silently doing nothing; making a video's preview image can no longer hang; Cancel stops at once; and messages never show raw browser errors.
- Keyboard focus stays inside the photo viewer and the sheets and returns to where it was.
- Text on buttons stays readable with any album colour, and secondary and error text reach the WCAG AA contrast level on every look. Linen, Mist and Sage use a slightly darker colour so their white button text is readable. Switches and option buttons are labelled for screen readers, and the join page announces its errors.
- The release's environment example leaves `PUBLIC_ORIGIN` commented out, so invitation links follow `ORIGIN` instead of pointing at localhost.
- Stopping a container while it is starting up (waiting for the database or for another copy to finish) now ends it at once. The health check allows for a slow start; building the image needs Docker Engine 25 or later.
- The reverse proxy must send `X-Forwarded-For` (the hosting guide now says so); without it the server logs a warning once, because every guest would share one rate limit.
- Editing only comments or spacing in the database schema no longer stops existing installations from starting. Existing databases are accepted and updated on first start.
- A release publishes exactly the image that was tested and scanned, and refuses a version number that was already used, drafts included. An image build fails if a platform-specific part could not be downloaded, instead of keeping a broken step in the build cache.
- The project website reads fully without JavaScript, fits small phones without sideways scrolling, and announces copied commands to screen readers.
