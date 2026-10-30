# Notification sounds

The desk knows **six sounds by name**, and each name is one **Ogg Vorbis**
file in this folder. These files are part of the source, not an optional
extra that may or may not be present in a release: a given name sounds the
same on every machine the product is installed on.

| File | Name in the desk | فارسی | Character |
| --- | --- | --- | --- |
| `chime.ogg` | Chime | زنگ | two bell strikes a fifth apart |
| `ding.ogg` | Ding | دینگ | one bright strike, short |
| `rise.ogg` | Rising | صعودی | a rising triad — bullish |
| `fall.ogg` | Falling | نزولی | a falling triad — bearish |
| `alert.ogg` | Alert | هشدار | two clipped pulses on one pitch |
| `soft.ogg` | Soft | ملایم | one low note that fades in |

The names are fixed and lower-case. `Chime.ogg` or `chime.OGG` will not be
found on a case-sensitive server, and no other extension is read — the desk
asks for `.ogg` and only `.ogg`.

## Which sound plays when

The **sound** and the **event** are separate things. The six files above are
the sounds; the desk has four events, and each event is pointed at one of
the six in **Settings → Sound & Notifications**:

| Event | Default sound |
| --- | --- |
| the robot opens a position | Chime |
| a position closes in profit | Rising |
| a position closes at a loss | Falling |
| an ordinary notification (saved settings, reconnects, refusals) | Soft |

That indirection is why there is no per-event file and no *Sound file*
option in the panel: every option in that list is already a file.

## Regenerating them

The files are generated rather than recorded, so they are reproducible,
license-clean and tiny:

```sh
python3 scripts/make-sounds.py
```

That script is the definition of what each sound is — frequencies,
envelopes and all — so a change to one of them is a change to a few lines
of Python rather than an opaque binary dropped into the tree. It needs
`numpy` and `soundfile`.

## Replacing one by hand

Nothing stops you overwriting a file with a recording. If you do:

- **Ogg Vorbis.** It is the one format every browser and WebView the desk
  runs in can decode. A file renamed to `.ogg` is not an Ogg file: the desk
  decodes it before use and falls back to the synthesized tone if it cannot.
- **Keep it short** — a second or two. This is a notification, and it plays
  while the trader is looking at something else.
- **Keep it small.** The files are fetched once at start-up. The generated
  ones are 6–12 kB each; that is the right order.
- **Normalise the level.** The desk applies the master volume from Settings
  on top of whatever is in the file, so a file recorded hot will be loud
  relative to the others at the same slider position.

```sh
ffmpeg -i source.wav -c:a libvorbis -q:a 4 -ac 1 chime.ogg
```

## If a file is missing

That sound falls back to a synthesized tone of the same name, built into
`apps/web/js/app.js` (the `SOUNDS` table, whose frequencies match this
folder). The desk is never silent just because a file has not been added —
it just sounds plainer. A missing file is a degraded state, not an error.

## Checking it worked

Open **Settings → Sound & Notifications** and press the play button beside
a row to hear exactly what will play. To confirm a file is genuinely Ogg
Vorbis:

```sh
ffprobe chime.ogg        # should report: Audio: vorbis
```

The files are copied into the installer automatically with the rest of
`apps/web`, so there is nothing to add to `stage.ps1`.
