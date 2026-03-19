# ArcGIS Assistant Demo

React + Vite demo built with ArcGIS Maps SDK, ArcGIS Assistant, and an MCP hub.

## Disclaimer

Most of this app has been vibe coded with various coding agents. Review the code, configuration, and deployment choices before using it beyond demos or internal experimentation.

## Hosted App

If you just want to use the app in a browser, open:

- [ArcGIS Assistant Demo](https://ralouta.github.io/ArcGIS-JavaScript-AI-Component/)

## What It Does

- Sign in with ArcGIS and load an existing WebMap or create a new one.
- Use built-in map-aware assistant tools for navigation and data exploration.
- Use MCP-backed tools for external workflows such as weather, catalog, or custom server tasks.
- Create and manage hosted feature layers from assistant results.

## Local Development Requirements

- Node.js 18+
- An ArcGIS OAuth client ID
- A WebMap item ID to load, or permission to create WebMaps in your ArcGIS org

## Local Setup

### 1. Clone The Repository

```bash
git clone https://github.com/ralouta/ArcGIS-JavaScript-AI-Component.git
cd ArcGIS-JavaScript-AI-Component
```

### 2. Install Dependencies

With `npm`:

```bash
npm install
```

With `npx` only, you can run the app and hub from the repo without relying on npm scripts:

```bash
npx vite
npx tsx hub/server.ts
```

### 3. Configure Environment

Create `.env.local` in the project root:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-client-id
VITE_ARCGIS_PORTAL_URL=https://www.arcgis.com
VITE_APP_NAME=ArcGIS Assistant Demo
```

### 4. Configure ArcGIS OAuth

1. Create an ArcGIS OAuth app.
2. Add redirect URLs: `http://localhost:5173` and `http://localhost:4173`.
3. Copy the client ID into `VITE_ARCGIS_OAUTH_APP_ID`.

## Local Run Commands

With `npm` scripts:

```bash
npm run dev
npm run hub
npm run hub:dev
npm run build
npm run preview
```

With `npx` commands:

```bash
npx vite
npx tsx hub/server.ts
npx tsx --watch hub/server.ts
npx vite build
npx vite preview
```

Run the app and hub in separate terminals when using MCP features.

## Using The App

1. Sign in with ArcGIS.
2. Load a WebMap by item ID, or create a new map.
3. Ask map questions, run MCP-backed prompts, or create/manage hosted layers.

Demo WebMap ID:

```text
0cafaf0aa4174e5bac19113ab69bdc85
```

Example prompts:

- `what layers are in this webmap?`
- `navigate me to baalbek`
- `get the weather forecast for Beirut`
- `create a point layer named Sites with fields: Name:string, Category:string`
- `add the latest results to the last created feature layer`

## MCP Hub

The local hub in `hub/server.ts` aggregates multiple MCP servers behind one endpoint.

You can add servers in two ways from the MCP manager:

- Command-based `stdio` servers such as `npx`, `node`, `python`, or `uvx`
- Direct HTTP MCP server URLs

Example remote bridge via `mcp-remote`:

```text
Command:   npx
Arguments: mcp-remote https://your-remote-mcp-server.com/mcp
```

The hub runs on port `8808` by default and is proxied through Vite at `/api/mcp` during development.

## Assistant Notes

- The assistant stays available even on empty maps.
- Map-aware built-in tools wait until the map is ready and assistant data has been prepared.
- Empty maps still support MCP and custom assistant workflows.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sign-in fails | Check `VITE_ARCGIS_OAUTH_APP_ID` and redirect URLs |
| Map will not load | Verify the WebMap ID and sharing permissions |
| MCP tools are unavailable | Confirm `npm run hub` is running and the server status is healthy |
| Feature layer creation fails | Verify the account can create hosted feature layers |
| Map-aware answers are weak | Refresh assistant data for the current map |

## URL Parameters

The only supported URL parameter is `?mode=edit`.

Use it when you want the wider assistant panel and the theme editor controls:

```text
http://localhost:5173/?mode=edit
```

