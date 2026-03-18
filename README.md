# ArcGIS Assistant Demo

React + Vite demo built with ArcGIS Maps SDK and ArcGIS Assistant.

**What it does:**
- Sign in with ArcGIS, load a WebMap by item ID
- Ask the assistant questions about the map (navigation, data exploration)
- Create hosted feature layers from natural language
- Connect external MCP servers and use their tools directly in the assistant

---

## Requirements

- Node.js 18+
- ArcGIS OAuth client ID
- A WebMap item ID to load

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Environment

Create `.env.local` in the project root:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-client-id
VITE_ARCGIS_PORTAL_URL=https://www.arcgis.com   # omit for ArcGIS Online default
VITE_APP_NAME=ArcGIS Assistant Demo              # optional
```

### 3. ArcGIS OAuth App

1. Sign in to your ArcGIS portal and create an OAuth app.
2. Add redirect URLs: `http://localhost:5173` and `http://localhost:4173`.
3. Copy the client ID into `VITE_ARCGIS_OAUTH_APP_ID`.

---

## Run

```bash
npm run dev       # start the app
npm run hub       # start the MCP hub (required for MCP features)
npm run hub:dev   # start the MCP hub in watch mode
npm run build     # production build
npm run preview   # preview the build
```

Run the app and hub in separate terminals.

---

## Using the App

1. Sign in with ArcGIS.
2. Enter a WebMap item ID and click **Load map**.
3. Ask the assistant anything about the map.

**Demo WebMap ID:**
```
0cafaf0aa4174e5bac19113ab69bdc85
```

**Example prompts:**
- `what layers are in this webmap?`
- `navigate me to baalbek`
- `create a point layer named Sites with fields: Name:string, Category:string`
- `get the weather forecast for Beirut` *(requires a weather MCP server)*

---

## Feature Layer Creation

Ask the assistant to create hosted feature layers:

- `Create a point layer named Facilities with fields: Name:string, Capacity:int`
- `Create a polygon layer called Zoning with fields: Zone:string, MaxHeight:int`
- `Create a polyline layer named Trails with fields: Name:string, Length:double`

---

## MCP Hub

The app ships with a local MCP hub (`hub/server.ts`) that aggregates multiple MCP servers into a single endpoint the assistant can query.

### Start the hub

```bash
npm run hub
```

### Add MCP servers

Click the **MCP icon** (⚙) in the assistant panel header to open the server manager. From there you can:

- **Add a server** — specify a command, arguments, and optional env vars. Any launch pattern works: `npx`, `node`, `python`, `uvx`, etc.
- **Import from desktop config** — paste a JSON snippet in the standard `mcpServers` / `command` / `args` / `env` format.
- **Start / stop / remove** servers at runtime.

To bridge to a remote MCP server over stdio, use `npx mcp-remote` as the command:

```
Command:   npx
Arguments: mcp-remote https://your-remote-mcp-server.com/mcp
```

The hub runs on port `8808` by default and is proxied through Vite at `/api/mcp` during development.

---

## Embeddings

The app auto-generates WebMap embeddings on first load. Weak answers usually mean stale embeddings — regenerate them to fix.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sign-in fails | Check `VITE_ARCGIS_OAUTH_APP_ID` and redirect URLs |
| Map won't load | Verify WebMap ID and its sharing permissions |
| MCP tools unavailable | Confirm `npm run hub` is running and the server status shows green |
| Feature layer creation fails | Verify your account has permission to create hosted feature layers |
| Weak map answers | Regenerate WebMap embeddings |