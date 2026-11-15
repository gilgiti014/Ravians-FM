# Ravians FM – Campus Web Radio

A real web radio: the presenter talks into the microphone, every listener hears it live.

## Start (presenter's computer)
* **Windows:** double-click `START-WINDOWS.bat` (needs Node.js from nodejs.org – install once).
* **Mac/Linux:** `./start.sh`

The Studio opens in your browser. Enter PIN `ravians` (change it: `STUDIO_PIN=mypin node server.js`),
allow the microphone, press **Start Broadcast**. Talk – listeners hear you.

## Give listeners a link
**Same campus Wi-Fi:** share the `http://<ip>:3000` address printed in the black window.

**Anyone, anywhere (public https link)** – while the server is running, in a second window run ONE of:
```bash
npx cloudflared tunnel --url http://localhost:3000
npx localtunnel --port 3000
```
It prints a public `https://…` link. Share it with students. (You can also open that link as presenter, from any device.)

**Permanent hosting:** push this folder to GitHub and deploy on render.com (New → Blueprint, uses `render.yaml` + `Dockerfile`).
On free hosting uploaded songs/recordings are lost on restart.

## Listening
Works on every phone and computer. Chrome/Edge/Firefox use a low-delay stream; iPhone/Safari automatically
use a standard MP3 stream (needs `ffmpeg` on the server – included in the Docker image; on Windows install it from ffmpeg.org
or `winget install ffmpeg`). The same stream is at `/stream.mp3` for VLC etc.

## Features
Live mic broadcast · play songs on air · mute mic · listener count · ON AIR badge · announcements ·
programs · weekly schedule (editable in Studio) · songs library · recorded shows (auto-saved) · upload/delete audio.
