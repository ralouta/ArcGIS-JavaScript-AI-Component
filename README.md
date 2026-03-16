# ArcGIS Assistant Demo

Simple React + Vite demo built with ArcGIS Maps SDK and ArcGIS Assistant.

The app lets you:
- sign in with ArcGIS
- load a WebMap by item ID
- ask questions about the map
- create hosted feature layers from natural language

## What You Need

- Node.js 18+
- an ArcGIS OAuth app/client ID
- access to a WebMap

## ArcGIS OAuth Setup

Create an OAuth app in the same ArcGIS portal your users will sign in to.

For ArcGIS Online:

1. Sign in to ArcGIS Online.
2. Create an app / developer credentials item.
3. Copy the client ID.
4. Add these redirect URLs:
	- `http://localhost:5173`
	- `http://localhost:4173`
5. Save the app.
6. Put that client ID into `VITE_ARCGIS_OAUTH_APP_ID` in `.env.local`.

Use these redirect URLs:
- `http://localhost:5173`
- `http://localhost:4173`

If you use ArcGIS Online, create the OAuth app there.
If you use ArcGIS Enterprise, create it in that Enterprise portal.

## Install

```bash
npm install
```

## Environment

Create a `.env.local` file in the project root:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-app-id
VITE_ARCGIS_PORTAL_URL=https://www.arcgis.com
VITE_APP_NAME=ArcGIS Assistant Demo
```

Notes:
- `VITE_ARCGIS_OAUTH_APP_ID` is required
- `VITE_ARCGIS_PORTAL_URL` is optional if you use ArcGIS Online
- for ArcGIS Enterprise, set `VITE_ARCGIS_PORTAL_URL` to your portal URL

Example:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-client-id-from-arcgis-online
```

Example for Enterprise:

```bash
VITE_ARCGIS_PORTAL_URL=https://your-portal.domain.com/portal
```

## Run

Start the app:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the build:

```bash
npm run preview
```

## How To Use

1. Start the app.
2. Sign in with ArcGIS.
3. Enter a WebMap item ID.
4. Click `Load map`.
5. Ask the assistant questions about the map.

## Demo WebMap

You can test with this public WebMap ID:

```text
0cafaf0aa4174e5bac19113ab69bdc85
```

## Example Prompts

- `what layers are in this webmap?`
- `summarize the visible layers`
- `navigate me to baalbek`
- `clear filters`

## Feature Layer Creation

The app can also create hosted feature layers from natural language.

Examples:
- `Create a point feature layer named Facilities with fields: Name:string, Capacity:int`
- `Create a polygon layer called Zoning with fields: Zone:string, MaxHeight:int`
- `Create a polyline feature layer named Trails with fields: Name:string, Length:double`

## Embeddings

The app automatically checks for WebMap embeddings and generates them when needed.
If needed, you can manually regenerate embeddings from the assistant panel.

## Troubleshooting

- If sign-in does not work, verify `VITE_ARCGIS_OAUTH_APP_ID`
- If the map does not load, verify the WebMap ID and sharing permissions
- If answers are weak, regenerate embeddings
- If hosted layer creation fails, verify your ArcGIS account has permission to create hosted feature layers

## Optional MCP Setup

MCP is optional.

If you want to connect an MCP server, open the MCP configuration in the app and add your server URL.

Use:
- `/api/arcgis-mcp` if you want to use the built-in Vite proxy during local development
- `http://localhost:8000` if you want to call your local MCP server directly and it supports CORS

If direct localhost access gives `Failed to fetch`, use `/api/arcgis-mcp` instead.