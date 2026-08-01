# Voice Agent Web Client

Minimal webpage for talking to an xAI [Speech to Speech](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) voice agent, with a small Node.js proxy that keeps your `XAI_API_KEY` off the client.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in XAI_API_KEY
npm start
```

Open http://localhost:3000, click **Connect**, then **Start mic** (or type a message).

## Deploy

The app is a single Node.js process (`server.js`) that serves the static page and proxies the WebSocket to xAI. Deploy it on [Render](https://render.com) using the included [render.yaml](render.yaml) Blueprint:

1. Push this repo to GitHub.
2. In Render, **New +** → **Blueprint**, select the repo.
3. Set the `XAI_API_KEY` secret when prompted, deploy.


The server exposes `GET /healthz` for Render's health check and binds to `0.0.0.0` by default (override with `HOST`/`PORT` env vars).

