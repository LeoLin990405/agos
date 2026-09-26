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
| `OPENAI_API_KEY` | Chat translation when that provider is selected |
| `LIBRETRANSLATE_URL` | Self-hosted LibreTranslate |
| `MINIMAX_API_KEY` | Required for English speech. Never put it in the page |
| `MINIMAX_API_HOST` | `https://api.minimaxi.com` (China token plan) or `https://api.minimax.io` |
| `MINIMAX_VOICE_ID` | Default `female-shaonv`, the voice id the agos `speak` tool uses for MiniMax. Set this to a cloned voice id to hear that voice |
| `MINIMAX_CLONE_AUDIO` | Optional mp3/wav sample. Uploaded once, then registered as `MINIMAX_VOICE_ID` |
| `DSH_CN_VISION_DIR` | If this directory contains `speech.py`, the studio calls that script with `--provider minimax` instead of HTTP |

`auto` translation uses DeepSeek, then OpenAI, then LibreTranslate, then the public [MyMemory](https://mymemory.translated.net/) service. MyMemory needs no key and is rate limited; the Mandarin you speak is sent to that service. The page says so when it is the active provider.

English speech is MiniMax. The request is `POST /v1/t2a_v2` with `voice_setting.voice_id`. When `speech.py` from dsh-vision is installed, the studio uses the same command as the agos `speak` tool: `speech.py speak TEXT --out wav --provider minimax --voice <id>`. Without `MINIMAX_API_KEY`, the browser can still read the English aloud, but that voice is not in the recording.

If Chrome already has its on-device translator downloaded (`Translator.availability === "available"`), the page uses that model before the server.

## Limits

- Speech recognition is Chrome's Web Speech API (`zh-CN`). It needs a microphone and Google's recognition service. Safari and Firefox will not start the mic path; rehearsal still runs.
- Interpretation is clause-by-clause, not a word-level phoneme stream. The first English usually appears at the first pause or punctuation mark.
- MyMemory quality and quota are those of a public anonymous endpoint. A DeepSeek or OpenAI key is the private path.
- MiniMax is a synthetic voice. `female-shaonv` is the built-in default, not a clone of your voice. A cloned id comes from the MiniMax console, or from `MINIMAX_CLONE_AUDIO` plus your own `MINIMAX_VOICE_ID`.
- The agos `speak` tool's `--clone` sample path is documented for Xiaomi MiMo, not for MiniMax. MiniMax cloning in this studio uses MiniMax `/v1/voice_clone`.
- There is no "drop in a finished Chinese video and get a fully dubbed English video" path. The hackathon `speak` tool only turns text into a wav. Dubbing a finished video would still need offline transcription of that file, translation of the whole track, MiniMax synthesis, and an ffmpeg mux. The studio records a live take instead.
- The recording is WebM (VP8 + Opus). Camera permission is required for your picture; without it the file still contains the studio frame, captions, and the MiniMax dub.
