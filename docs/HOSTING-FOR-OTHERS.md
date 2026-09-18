# Hosting albums for other people

Running Mira for your own trips is one thing. Letting other people create albums on
your server, with their own guests, makes you the keeper of strangers' photos. This
note says in plain words what that takes, what Mira already does for you, and the
smallest sensible way to start. It is not legal advice.

Mira has no billing and no public sign-up page, on purpose. Nothing below needs them.

## The short version

Start with **invited owners on your own server**: people you know, added one by one,
each with a storage limit, on a server you already back up. That needs no new
software, only the settings described under "The smallest first step". Opening the
door to anyone, or charging money, is a different undertaking: it adds legal duties,
support and cost that the software cannot carry for you.

## What changes when the owners are not you

Today you decide what goes on your server, because every album is yours. Once other
people own albums:

- **You hold photos of people you have never met**, including children, with the
  date and often the place each was taken. Mira keeps originals with that
  information; that is its point, and it is also what makes the data sensitive.
- **You cannot see trouble coming.** An owner invites whoever they like, and guests
  upload whatever they like. You find out when someone complains, or when the disk
  is full.
- **You are the one people write to** when a link stops working, a video will not
  upload, or someone wants a photo of themselves removed.

## What Mira already gives you

All of this exists today, under **Admin** (the shield on the home page) unless noted.

| Need                                | What exists                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decide who may own albums           | Registration: **closed** (the default on a new copy), an **allow-list** of emails or `@domains`, or open. Guests never need an account.                                                   |
| Limit how much each owner stores    | A default storage limit per owner (10 GB unless you change it) and a separate limit for any single owner. Originals and video copies both count. Uploads over the limit are refused.      |
| Limit the size of things            | Largest photo (40 MB by default), largest video (2 GB by default), most albums per owner (50 by default).                                                                                 |
| Stop something at once              | **Take down** an album: it becomes unreachable for everyone, and is kept until you decide. **Block** an account. **Pause uploads** or **pause album creation** for the whole server.      |
| Remove something for good           | Delete a single photo or video (from its own screen, as the album's owner), a whole album, or an account with all its albums. Files leave the disk within minutes.                        |
| Tell guests whose server it is      | `MIRA_OPERATOR_NAME`, `MIRA_OPERATOR_CONTACT` and `MIRA_RETENTION_NOTE` put your name, a way to reach you and how long you keep photos on the sign-in page, the join page and `/privacy`. |
| See how full it is                  | Admin, Overview: accounts, albums, photos, videos and total storage; each account's use against its limit.                                                                                |
| Keep an owner's event under control | Owners can require approval of uploads, close an album, and replace an invitation link that has travelled too far.                                                                        |

## What Mira does not do, and you would have to

**Removing things on request.** There is no "report this photo" button and no inbox.
A guest who wants a photo removed has to reach the album's owner or you. Decide how
they reach you (the contact you publish), how fast you answer, and keep a note of
what you removed and why. For anything that looks illegal, take the album down first
and ask questions afterwards.

**Checking what is uploaded.** Mira does not look at the content of photos and
videos. If you host for people you do not know, some of them will upload things you
would not want on your server, and a few may upload things it is a crime to hold.
This is the main reason not to open registration to the public.

**Backups.** Mira does not back itself up. You need a copy of the database and of
the media folder, taken together, kept somewhere other than the server, and a restore
you have actually tried. When photos were only yours, a lost disk was your loss. Now
it would be someone's wedding.

**Terms and privacy text.** `/privacy` describes what the software stores and who
can see it. It is not a privacy notice from you, and Mira ships no terms of use. If
you host for others you are, in most countries, legally responsible for those
photos: people can ask what you hold about them and ask for it to be deleted, and
you must look after it properly. In the European Union this is the GDPR. Get the
texts and your duties checked by someone qualified before hosting for anyone you do
not know personally.

**Disk for kept originals.** Originals are large, and Mira keeps them. Measured on
this project's test machine with a synthetic clip: a 982 MB video is stored as the
982 MB original plus a 48.6 MB copy for playback, about 1,030 MB in all. Photos from a phone are a few megabytes
each. As a rough guide, a weekend with forty people might be five hundred photos and
thirty videos: around 2 GB of photos and anything from 3 to 30 GB of video,
depending on how long the clips are. Ten such events can fill a 100 GB disk. Three
things keep this bounded: the per-owner limit, the largest-video limit, and telling
owners how long you keep albums. An owner who is short of space can choose "Save
space: keep only the small copy" for an album; then only the small copies are kept
and the album says so to everyone.

**Support.** Expect questions: a guest with a new phone (you or the owner can let
them back in from the album menu), an upload that stalls on a weak signal, someone
who cannot find the link. There are no email notifications and no password reset for
guests, by design. Each owner you add is a few of these a year.

**Staying up.** One server, one copy of the software: when it is down, every album
is down. For your own trips that is an inconvenience. For someone else's event on
the day, it is the whole product failing.

## The smallest first step

Host for people you know, by invitation, and nothing more:

1. **Keep registration closed or on the allow-list.** Add each new owner's email
   yourself (Admin, Settings, Registration). They sign in with the sign-in service
   you have configured; their guests need nothing.
2. **Give each owner a storage limit** you can afford several times over, for
   example 20 GB, and lower the largest video size if your disk is small.
3. **Say who you are.** Set the three `MIRA_OPERATOR_*` values, including how long
   you keep albums ("Albums are deleted one year after the event" is a good default:
   it limits your disk, your risk and your promises).
4. **Back up, and test the restore**, before the first album that is not yours.
5. **Tell each owner the house rules** in two lines when you invite them: what the
   limit is, how long albums stay, and that they answer for what their guests upload.
6. **Look at Admin, Overview once a month.**

That is enough to learn whether anyone wants this from you, at a cost of some disk
and a little of your time.

## If it grows beyond people you know

Do not open registration until these exist, in this order: terms of use and a
privacy notice checked by someone qualified; a published way to report a photo and
a habit of answering within a day or two; backups you have restored from; monitoring
that tells you when the disk is nearly full or the server is down; and a decision on
what you will do when a stranger uploads something illegal. Charging money comes
after all of that, and brings accounting, refunds and a promise to stay online. The
paid event services exist because that work is real; it is a business to run, not a
feature to switch on.
