# Presentation Studio

Say Mandarin into the microphone. English captions and spoken English arrive while you are still talking. Then record a camera video with those English captions burned in and, when a speech engine is available, the English dub mixed into the file.

`https://github.com/LeoLin990405/presentation-studio` was not present, and the credential for this workspace can only push to [agos](https://github.com/LeoLin990405/agos). The studio lives in this folder so it can ship as a pull request without changing the AgOS cockpit.

## Run

```bash
cd presentation-studio
node server.mjs
```

Open http://127.0.0.1:4173/

1. **开始说中文** — Chrome listens with `zh-CN` interim results. A clause is translated at the first comma or full stop, and also if you pause, instead of waiting until you finish.
2. English shows on the live caption line and is spoken.
3. **打开相机**, then **开始录像**. The take is the stage you see: camera (or a studio card), Mandarin, English, and the English audio when server TTS is available.
4. Stop to preview and download the WebM.

**排练一句** feeds a sample line through the same interpreter so you can try the path without a microphone.

## One-time setup

Copy `.env.example` to `.env` if you want a private model. Real keys stay in the environment or that file. Nothing in the client bundle contains a key.

| Variable | Role |
|---|---|
| `INTERPRET_PROVIDER` | `auto` (default), `deepseek`, `openai`, `libretranslate`, `mymemory`, or `off` |
| `DEEPSEEK_API_KEY` | Preferred chat translator. `DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com` |
| `OPENAI_API_KEY` | Chat translation and, if selected, TTS |
| `LIBRETRANSLATE_URL` | Self-hosted LibreTranslate |
| `TTS_PROVIDER` | `auto`, `espeak`, `openai`, or `browser` |
| `ESPEAK_BIN` | Default `espeak-ng`. `auto` uses it when the binary is on `PATH` |

`auto` translation uses DeepSeek, then OpenAI, then LibreTranslate, then the public [MyMemory](https://mymemory.translated.net/) service. MyMemory needs no key and is rate limited; the Mandarin you speak is sent to that service. The page says so when it is the active provider.

`auto` speech uses `espeak-ng` when installed (`apt install espeak-ng` or `brew install espeak-ng`). That audio is mixed into the recording. Without it, Chrome's `speechSynthesis` still reads the English aloud, but that voice is not part of the file. Set `TTS_PROVIDER=openai` to dub with OpenAI speech instead.

If Chrome already has its on-device translator downloaded (`Translator.availability === "available"`), the page uses that model before the server.

## Limits

- Speech recognition is Chrome's Web Speech API (`zh-CN`). It needs a microphone and Google's recognition service. Safari and Firefox will not start the mic path; rehearsal still runs.
- Interpretation is clause-by-clause, not a word-level phoneme stream. The first English usually appears at the first pause or punctuation mark.
- MyMemory quality and quota are those of a public anonymous endpoint. A DeepSeek or OpenAI key is the private path.
- espeak-ng is intelligible and clearly synthetic. It is not a broadcast voice.
- The recording is WebM (VP8 + Opus). Camera permission is required for your picture; without it the file still contains the studio frame, captions, and dub.
