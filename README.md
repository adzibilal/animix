# Animix

A local prompt-to-video studio. Pick a style, describe an idea, and an agent on this computer writes a timed script, speaks the narration, and renders a short animated video.

Animix is a fork of **[owlinthebarnai/video-studio-kit](https://github.com/owlinthebarnai/video-studio-kit)** by [owlinthebarnai](https://github.com/owlinthebarnai). The original kit is a prompt-to-video studio for Claude Code: 100+ styles, a local voice, generated music, and 50+ video skills, all running on your own Claude subscription. This fork keeps that kit and adds a project dashboard, Indonesian-first voice-over, optional cloud voices, and social scheduling. Thank you to the original author and to every project listed under [Credits](#credits).

The studio UI is called **Animix**. It runs at [http://localhost:4790](http://localhost:4790). Finished videos are copied to `outputs/`.

## What you can do

- Browse **109 styles** (93 of them have a 5-second preview), write a prompt, and get a scene-by-scene script. Edit times, visuals, narration, on-screen text, and sound, then render.
- Start from a **new-video wizard**: idea, title suggestions, number of parts, length, voice-over, aspect ratio, and music.
- Keep videos on a **dashboard** with folders, search, and status.
- Generate the script and the video with **Claude Code** or the **Cursor agent**, each on its own subscription login. No separate model API key is required for that step.
- Add a voice-over. **Kokoro** still runs locally and needs no key (English). Optional cloud voices, with key rotation, are Google Gemini, ElevenLabs, Fish Audio, and Edge TTS. Defaults favour Bahasa Indonesia.
- Save a **format reference**: a transcript whose structure the agent copies, without copying its topic.
- Burn short captions on cartoon-3D shorts, compress a finished file for social upload, and draft post metadata.
- Schedule a post through **[Repliz](https://repliz.com)** when `REPLIZ_ACCESS_KEY` and `REPLIZ_SECRET_KEY` are set.

44 of the style previews retell the same story, *the discovery of fire*, so styles can be compared side by side. The others play a clip of that style's own demo.

API keys live only in `.env` and usage state in `.keys.json`. Both are gitignored. The agent process does not receive them.

## What this fork adds

| Area | Change |
|---|---|
| Dashboard | Folder library of videos at `/dashboard`, with search, sort, and status |
| Wizard | Title ideas, part count, length, voice, format, and music before the script is written |
| Voice | Provider chain (Gemini → ElevenLabs → Fish Audio → Edge TTS → Kokoro), per-language voices, speed, and a preview |
| Settings | API keys, voice defaults, and which agent writes and builds (`#settings`) |
| Agents | Claude Code or Cursor (`cursor-agent`), with a model for scripts and a model for builds |
| Social | AI post metadata, ffmpeg compression presets, and Repliz upload and scheduling |
| Captions | Short burned-in captions for `cartoon3d` videos |
| Launcher | `start-studio.sh` trusts the system CA bundle (useful behind TLS inspection) and opens Chrome from WSL |

The upstream kit's skills, demos, and setup flow are unchanged.

## Requirements

| | |
|---|---|
| [Claude Code](https://claude.com/claude-code) and/or the Cursor agent, logged in | writes scripts and builds videos on your subscription |
| Node.js 20+ and git | |
| Python 3.10+ | local Kokoro voice |
| ffmpeg on your PATH | Windows: `winget install Gyan.FFmpeg` · macOS: `brew install ffmpeg` |
| Blender 4.2+ (optional) | only for the Blender clay and toon styles. Set `BLENDER` to its path. |
| ~3 GB of free disk space | dependencies, the voice model, and renders |

Cloud voice and Repliz are optional. Without those keys, the studio still runs on the local Kokoro voice (English) and your agent subscription.

The upstream kit was tested on Windows 11. This fork is also used on Linux and WSL.

## Install

```sh
git clone https://github.com/adzibilal/video-studio-kit.git
cd video-studio-kit
node setup.mjs          # add --all to also fetch every optional source repo
```

Setup does the following:

1. Checks the requirements.
2. Clones the third-party repos it needs at pinned versions.
3. Refreshes the Remotion skills from their own repo.
4. Installs the Node dependencies and a headless browser.
5. Downloads the Kokoro voice (about 340 MB).

You can run it again safely.

Optional keys, in `.env` at the repo root (never commit this file):

```sh
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
FISH_API_KEY=
EDGE_TTS_KEY=
REPLIZ_ACCESS_KEY=
REPLIZ_SECRET_KEY=
```

Extra keys for the same provider use a numeric suffix (`GEMINI_API_KEY_2`, and so on). The same keys can also be added in the app under Settings.

## Use

**In the app.** On Windows, double-click `Start Video Studio.cmd`. On macOS or Linux, run `sh start-studio.sh`. On WSL the script opens Chrome on the Windows side. The app listens on http://localhost:4790 and the library is at http://localhost:4790/dashboard.

1. Create a video from the dashboard or press **New video**.
2. Describe the idea, generate titles, and pick a style. The preview plays that style's example.
3. Choose parts, length, voice-over, format, and music, then generate the script.
4. Edit the script table.
5. Press **Validate script & generate video**. The agent renders each scene and the studio stitches them. When it finishes, the video opens with **Open folder** and **Save a copy**.

**In Claude Code.** Open a terminal in this folder, run `claude`, then type `/video-studio a 30-second story about …`.

## How generation is billed

Writing a script is one short agent call. Building a video runs the chosen agent headless in this folder with file and shell tools: it reads the style's skill, writes the scene code, renders, and checks frames. That uses the agent's plan the same way a long conversation does, and it depends on the style and the length. Voice providers and Repliz are billed by those services only when you use them. Nothing from `.env` is sent to the agent.

## Speed (Intel laptop GPU)

| Style family | 5 s of video |
|---|---|
| Fast: tvhead, HyperFrames, Remotion, kinetic, science, exploded view | about 1 to 3 min |
| Medium: painted, lemo films, motion-studio | about 3 to 10 min |
| Slow: Blender clay (Cycles) | about 30 min |

## Folders

| Folder | What's in it |
|---|---|
| `video-studio/` | the Animix app (`vs.mjs` server, `agent.mjs` runner, `ui/`, `lib/`, `catalog.json`, `tools/`) |
| `.claude/skills/` | the skills, including `video-studio`, the orchestrator |
| `studio/` | the tvhead engine, with the Kokoro voice patch |
| `demos/` | the working setup of each tool that the build recipes start from |
| `repos/` | third-party sources, cloned by setup (not in git) |
| `overlays/` | additions to those sources, applied by setup |
| `outputs/` | finished videos (not in git) |

## Credits

### Fork source

This repository is forked from **[owlinthebarnai/video-studio-kit](https://github.com/owlinthebarnai/video-studio-kit)**. The studio, the skill catalog, setup, the tvhead engine patch, and the original Video Studio UI come from that project. Animix keeps that work and extends the app. Please treat the upstream repository as the source of the kit.

### Skills and engines

The kit stands on these open-source projects. Thank you to their authors.

- [JohnHeibel/ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase): the painted watercolour engine (same as painted-animation)
- [Leonxlnx/earshot](https://github.com/Leonxlnx/earshot): earshot and real-sound: judging and building sound
- [LottieFiles/motion-design-skill](https://github.com/LottieFiles/motion-design-skill): motion-design principles
- [morgsdoti/story-video-studio](https://github.com/morgsdoti/story-video-studio): story-video-studio: stickman survival story prompt
- [Vladic20/tvhead-studio](https://github.com/Vladic20/tvhead-studio): tvhead-video (15 story looks incl. stickman), motion-studio (anime, motion reel), blender-3d, ai-montage
- [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender): Blender MCP (Claude controls an open Blender)
- [angrypenguinpng/blender-claymation-skill](https://github.com/angrypenguinpng/blender-claymation-skill): blender-claymation: Cycles clay stop-motion
- [cth9191/animate](https://github.com/cth9191/animate): animate: one-canvas procedural pieces with a synth score
- [greensock/gsap-skills](https://github.com/greensock/gsap-skills): GSAP animation skills
- [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes): HyperFrames: HTML + GSAP to video, registry of blocks, media tools
- [kelano86/what-if-animation](https://github.com/kelano86/what-if-animation): what-if-animation stick-figure episodes
- [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar): lemo-opuscar: 66 short-film styles
- [mromidev/claude-animated-shorts](https://github.com/mromidev/claude-animated-shorts): cartoon-3d-short: 2D cartoon cards in a 3D world
- [openai/whisper](https://github.com/openai/whisper): Whisper: word timings for captions
- [remotion-dev/skills](https://github.com/remotion-dev/skills): the Remotion skills (React video)
- [showheyohtaki/motion-prompt](https://github.com/showheyohtaki/motion-prompt): motion-prompt: library of 120 motion moves
- [tuzhechen2005/opus-video-skills](https://github.com/tuzhechen2005/opus-video-skills): kinetic-reel and painted-animation
- [zhuyansen/awesome-claude-video-skills](https://github.com/zhuyansen/awesome-claude-video-skills): index of Claude video skills (where many of these were found)
- **claude-animation-styles** kit by [@ernestosoftware](https://x.com/ernestosoftware) on X: the ten Claude animation styles (pixel art, PS2, comic, brick toy, claymation, paper cutout, retro anime, low poly, risograph, miniature diorama)

Built on: [Claude Code](https://claude.com/claude-code), [Remotion](https://www.remotion.dev), [three.js](https://threejs.org), [GSAP](https://gsap.com), [Playwright](https://playwright.dev), [FFmpeg](https://ffmpeg.org), [Blender](https://www.blender.org), the [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voice via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx), and [Kenney](https://kenney.nl) CC0 3D models.

## Licences

Third-party code keeps its own licence; see [THIRD_PARTY.md](THIRD_PARTY.md). Remotion's skills are included as published in [remotion-dev/skills](https://github.com/remotion-dev/skills) (that repo has no licence file); Remotion itself has its own licence: https://www.remotion.dev/docs/license

Upstream code in this fork remains under the terms of [owlinthebarnai/video-studio-kit](https://github.com/owlinthebarnai/video-studio-kit).
