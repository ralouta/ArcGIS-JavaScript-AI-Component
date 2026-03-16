# ArcGIS Maps SDK Custom Assistant Demo

React + Vite demo that combines ArcGIS map components, ArcGIS Assistant built-in agents, and focused custom assistant extensions.

Current capabilities:
- ArcGIS OAuth sign-in against ArcGIS Online or Enterprise
- Load any WebMap by item ID
- Automatic WebMap embeddings generation and upload when missing
- Built-in assistant navigation and data exploration over the active map
- Custom hosted feature layer creation from natural language
- Thin passthrough integration to one or more local ArcGIS MCP servers for external ArcGIS search tasks
- Assistant self-description via a dynamic capabilities agent

The app works with a public demo WebMap or any WebMap the signed-in user can access.

## What The App Does

1. Authenticates the user with ArcGIS OAuth.
2. Loads a WebMap by item ID.
3. Checks whether embeddings exist for the current WebMap.
4. Generates and uploads embeddings automatically when required.
5. Lets the user query the active map with the built-in assistant.
6. Exposes custom actions for hosted feature layer creation and MCP-backed ArcGIS search.

## Assistant Capabilities

The assistant runtime currently includes:
- `Navigation`: built-in ArcGIS Assistant agent for pan, zoom, and place navigation.
- `Data Exploration`: built-in ArcGIS Assistant agent for querying and summarizing the currently loaded WebMap.
- `Create Feature Layer`: custom agent that creates hosted feature layers from natural language.
- `ArcGIS MCP Passthrough`: custom agent for localhost MCP-backed layer/content lookup and table/field inspection.
- `All Capabilities`: custom helper agent that reports the currently registered assistant capabilities at runtime.

Important routing rule:
- Questions about the active map or layers already visible in the loaded WebMap should be handled by the built-in map exploration agents, not by the MCP passthrough agent.
- The MCP integration is intended for external ArcGIS search and lookup through your local MCP service.

## Prerequisites

- Node.js 18+
- ArcGIS OAuth app registered in the same portal users sign in to
- ArcGIS account with privileges to create hosted feature layers if you want to test the create-layer agent
- Optional local ArcGIS MCP server if you want to use the MCP search features

## ArcGIS OAuth Setup

Use the same portal your users will authenticate against.

1. Sign in to your ArcGIS organization with an account that can create developer credentials.
2. Create Developer Credentials or an OAuth 2.0 application item.
3. Copy the generated client ID.
4. Add these redirect URIs:
   - `http://localhost:5173`
   - `http://localhost:4173`
5. Save the app and use the client ID as `VITE_ARCGIS_OAUTH_APP_ID`.

Important:
- ArcGIS Online users should create the OAuth app in their ArcGIS Online organization.
- ArcGIS Enterprise users should create it in their Enterprise portal.
- If the portal and OAuth app do not match, sign-in usually fails.

## Setup

### Install Dependencies

```bash
npm install
```

### Configure Environment

Create `.env.local` in the project root:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-arcgis-oauth-app-id
VITE_ARCGIS_PORTAL_URL=https://www.arcgis.com
VITE_APP_NAME=ArcGIS Assistant Demo
VITE_ARCGIS_MCP_PROXY_TARGET=http://127.0.0.1:8000
```

Environment variables:
- `VITE_ARCGIS_OAUTH_APP_ID`: required.
- `VITE_ARCGIS_PORTAL_URL`: optional. Defaults to `https://www.arcgis.com`.
- `VITE_APP_NAME`: optional app title shown in the UI.
- `VITE_ARCGIS_MCP_PROXY_TARGET`: optional Vite dev proxy target for the local MCP server. Defaults to `http://127.0.0.1:8000`.
- `VITE_ARCGIS_MCP_BASE_URL`: optional direct MCP base URL override. If not set, the app uses `/api/arcgis-mcp`.

Enterprise example:

```bash
VITE_ARCGIS_PORTAL_URL=https://your-portal.domain.com/portal
```

### Register Redirect URIs

Add these redirect URIs to the OAuth app:
- `http://localhost:5173`
- `http://localhost:4173`

## MCP Integration

This project does not reimplement your MCP backend in the frontend.

Instead, the app uses a thin client and a thin assistant agent:
- Browser requests default to `/api/arcgis-mcp`
- Vite proxies `/api/arcgis-mcp` to `VITE_ARCGIS_MCP_PROXY_TARGET`
- The default dev target is `http://127.0.0.1:8000`

Why `/api/arcgis-mcp` exists:
- It is a local frontend route used during development.
- Vite rewrites and forwards it to your actual MCP server.
- This keeps the UI decoupled from a hard-coded localhost URL and allows per-environment overrides.

The app also includes an MCP configuration dialog in the assistant header:
- Add one or more MCP servers
- Pick the active server
- Persist server configuration in browser local storage
- Run health checks and surface only MCP errors in the UI

Current MCP-backed tools exposed through the assistant:
- Search ArcGIS layers by keyword
- Search ArcGIS content by keyword and optional item type
- Inspect a feature layer attribute table as CSV
- Summarize a specific field from a feature layer

## Run

Available scripts:
- `npm run dev`: start the Vite development server
- `npm run build`: create a production build
- `npm run preview`: preview the production build locally

Typical flow:
1. Start the app.
2. Sign in.
3. Enter a WebMap ID.
4. Load the map.
5. Ask assistant questions or use the MCP and create-layer capabilities.

## WebMap IDs And Example Prompts

### Public Demo WebMap

Public Lebanon-focused demo WebMap:
- `0cafaf0aa4174e5bac19113ab69bdc85`

Sample prompts for that map:
- `show areas with ndvi average more than 0.75`
- `navigate me to baalbek`
- `show areas with ndvi average more than 0.75 in bekaa`
- `unfilter everything`

### Generic Prompts For Your Own WebMap

- `what layers are in this webmap?`
- `summarize the visible layers`
- `show areas with [metric] above [threshold]`
- `navigate me to [place name]`
- `show [metric] above [threshold] in [region]`
- `clear filters`

### Create Feature Layer Prompts

- `Create a point feature layer named Facilities with fields: Name:string, Capacity:int, OpenDate:date.`
- `Create a point feature layer and name it Schools.`
- `Create a polygon layer called Zoning with fields: Zone:string, MaxHeight:int.`
- `Create a polyline feature layer named Trails with fields: Name:string, Length:double.`

Notes:
- Geometry can be inferred from terms like `point`, `polyline`, and `polygon`.
- If geometry is missing and the agent cannot infer it safely, it asks for clarification.
- If no layer name is detected, a timestamp-based fallback is used.

### MCP Search Prompts

- `Search the MCP server for layers related to hydrants`
- `Find web maps about wildfire in the MCP server`
- `Get the feature table for https://.../FeatureServer/0`
- `Summarize the POPULATION field for https://.../FeatureServer/0`

## Embeddings Behavior

The built-in ArcGIS Assistant data exploration capability depends on embeddings for richer WebMap querying.

This app now automatically:
- Checks whether embeddings already exist for the current WebMap
- Generates embeddings when they are missing
- Uploads the embeddings resource back to the WebMap item

The embedding generation logic also handles more real-world WebMap structures than before, including nested and grouped operational layers, and resolves concrete sublayer service URLs before generating embeddings.

Manual regeneration is available from the assistant header refresh action.

## UI Notes

Recent UI behavior reflected in this repo:
- `arcgis-home` is rendered beneath the zoom controls for quick extent reset
- The assistant header includes change-map, refresh, and MCP configuration actions
- The MCP action uses the project MCP icon and supports multi-server management
- The app no longer shows a permanent `Local MCP: ok` banner; only actionable MCP errors are displayed

## Architecture Snapshot

- `src/App.tsx`
	- Auth flow
	- WebMap loading
	- embeddings lifecycle
	- assistant registration
	- MCP server configuration and health checks
- `src/agents/CreateFeatureLayerAgent.ts`
	- custom hosted feature layer creation workflow
- `src/agents/ArcgisMcpPassthroughAgent.ts`
	- thin MCP tool passthrough for external ArcGIS search and inspection
- `src/agents/AllCapabilitiesAgent.ts`
	- runtime capability inventory for the active assistant instance
- `src/utils/arcgisOnline.ts`
	- OAuth helpers
	- WebMap item and resource operations
	- embeddings generation and upload
- `src/utils/arcgisMcp.ts`
	- thin HTTP client for MCP health, search, table, and field summary endpoints
- `vite.config.ts`
	- Vite React config and MCP dev proxy

## Troubleshooting

- Sign-in does not appear or does nothing: verify `VITE_ARCGIS_OAUTH_APP_ID` and restart the dev server.
- Sign-in succeeds but the map does not load: confirm the WebMap ID exists and is shared with the signed-in user.
- Data exploration is weak or fails on a new map: use the refresh action to regenerate embeddings.
- Embeddings generation says no eligible layers were found: verify the WebMap actually contains feature layers with queryable attributes.
- Create feature layer fails: confirm the signed-in account can create hosted feature layers in the target portal.
- MCP requests fail: confirm the local MCP server is running and that `VITE_ARCGIS_MCP_PROXY_TARGET` or `VITE_ARCGIS_MCP_BASE_URL` points to the correct service.