# Notification sounds

Drop an **Ogg Vorbis** file in this folder, named after the event it belongs
to. Nothing else is needed: no manifest to edit, no code to change, no
rebuild step. The desk looks for these four names at start-up.

| File | Plays when |
| --- | --- |
| `entry.ogg` | the robot opens a position |
| `profit.ogg` | a position closes in profit |
| `loss.ogg` | a position closes at a loss |
| `notice.ogg` | an ordinary notification appears (saved settings, reconnects, refusals) |

The names are fixed and lower-case. `Entry.ogg` or `entry.OGG` will not be
found on a case-sensitive server, and no other extension is read - the desk
asks for `.ogg` and only `.ogg`.

## What happens to a slot with no file

It keeps its built-in synthesized tone. A missing file is the normal case,
not an error, so three of these four can be absent and the fourth will still
work.

## What the trader sees

A row in **Settings → Sound & Notifications** gains a *Sound file* option
when - and only when - this build ships a file for that event, so the list
can never name a sound that does not exist. The shipped file becomes that
event's default; a trader who picks a different tone keeps their choice, and
they can always switch back.

## Requirements

- **Ogg Vorbis.** It is the one format every browser and WebView the desk
  runs in can decode. A file renamed to `.ogg` is not an Ogg file: the desk
  decodes it before use and will fall back to the built-in tone if it cannot.
- **Keep it short** - a second or two. This is a notification, and it plays
  while the trader is looking at something else.
- **Keep it small.** The files are fetched once at start-up. A few tens of
  kilobytes each is the right order; a whole music track is not.
- **Normalise the level.** The desk applies the master volume from Settings
  on top of whatever is in the file, so a file recorded hot will be loud
  relative to the built-in tones at the same slider position.

## Converting

```sh
ffmpeg -i chime.wav -c:a libvorbis -q:a 4 -ac 1 entry.ogg
```

`-q:a 4` is ample for a short notification and `-ac 1` (mono) halves the size
for no audible loss on a sound this brief.

## Checking it worked

Open **Settings → Sound & Notifications**. If the file was found, the row for
that event offers *Sound file* and has it selected; press the play button
beside it to hear exactly what will play. If the option is missing, the file
was not found or could not be decoded - check the spelling of the name first,
then that it is genuinely Ogg Vorbis:

```sh
ffprobe entry.ogg        # should report: Audio: vorbis
```

The files are copied into the installer automatically with the rest of
`apps/web`, so there is nothing to add to `stage.ps1`.
