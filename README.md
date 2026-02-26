# ArcGIS Maps SDK + Assistant Custom Agent Demo

Production-style demo that combines:
- ArcGIS Assistant built-in agents (Navigation + Data Exploration)
- A custom LangGraph agent that creates hosted feature layers in ArcGIS Online/Enterprise
- Automatic WebMap embeddings management for Data Exploration queries

The app is designed so you can run it with a **public demo WebMap** or your **own WebMap ID**.

---

## What this demo does

1. Authenticates users with ArcGIS OAuth.
2. Loads a WebMap by item ID.
3. Generates and uploads embeddings when missing.
4. Enables natural-language map interaction plus hosted feature layer creation.

---

## Prerequisites

- Node.js 18+
- ArcGIS OAuth App ID created in the same portal users sign in to
- ArcGIS account with privileges to create hosted feature layers (for custom-agent testing)

### Create an ArcGIS OAuth App ID (high level)

Use the same portal your users will authenticate against.

1. Sign in to your ArcGIS organization (Online or Enterprise) with an account that can create developer credentials.
2. Go to **Content** and create a new item for **Developer credentials** (OAuth 2.0 app).
3. Create an OAuth client and copy the generated **Client ID**.
4. Add allowed redirect URIs:
	- `http://localhost:5173`
	- `http://localhost:4173` (optional, for preview)
5. Save changes and use the Client ID as `VITE_ARCGIS_OAUTH_APP_ID` in `.env.local`.

Important:
- ArcGIS Online users should create the OAuth app in their ArcGIS Online org.
- ArcGIS Enterprise users should create it in their Enterprise portal.
- If portal and OAuth app do not match, sign-in typically fails.

---

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment

Create `.env.local` in project root:

```bash
VITE_ARCGIS_OAUTH_APP_ID=your-arcgis-oauth-app-id
VITE_ARCGIS_PORTAL_URL=https://www.arcgis.com
VITE_APP_NAME=ArcGIS Assistant Demo
```

`VITE_ARCGIS_PORTAL_URL` is optional; default is `https://www.arcgis.com`.

Enterprise example (This might require further testing):

```bash
VITE_ARCGIS_PORTAL_URL=https://your-portal.domain.com/portal
```

### 3) Register OAuth redirect URIs

Add these redirect URIs to your OAuth app:
- `http://localhost:5173` (dev)
- `http://localhost:4173` (preview, optional)

---

## Run

```bash
npm run dev
```

Flow in the app:
1. Sign in.
2. Enter a WebMap ID.
3. Load map.
4. Ask assistant questions.

---

## WebMap IDs and prompt examples

### Public demo WebMap (Lebanon)

The demo WebMap ID below is public and intentionally Lebanon-focused:

- `0cafaf0aa4174e5bac19113ab69bdc85`

Lebanon-specific prompts (keep as-is for this map):
- `show areas with ndvi average more than 0.75`
- `navigate me to baalbek`
- `show areas with ndvi average more than 0.75 in bekaa`
- `unfilter everything`

### Use your own WebMap ID

You can load any WebMap you have access to. For non-Lebanon maps, use generic query phrasing:
- `show areas with [metric] above [threshold]`
- `navigate me to [place name]`
- `show [metric] above [threshold] in [region]`
- `clear filters`

---

## Embeddings behavior (important)

For `arcgis-assistant-data-exploration-agent`, embeddings are required.

This app automatically:
- generates embeddings if missing,
- uploads embeddings to the current WebMap item resource.

Manual regenerate is available from the assistant panel header (reset icon).

---

## Custom agent: Create Feature Layer

The custom agent parses natural language and creates a hosted feature layer/service.

### Recommended generic test prompts

- `Create a point feature layer named Facilities with fields: Name:string, Capacity:int, OpenDate:date.`
- `Create a point feature layer and name it Schools.`
- `Create a polygon layer called Zoning with fields: Zone:string, MaxHeight:int.`
- `Create a polyline feature layer named Trails with fields: Name:string, Length:double.`

### Lebanon-specific reference prompt (still valid)

- `Create a point feature layer named HospitalsLebanon with fields: Name:string, Capacity:int, OpenDate:date.`

Notes:
- Geometry can be inferred from terms like `point`, `polyline`, and `polygon`.
- If geometry type is missing and no default applies, the agent asks for clarification.
- If no layer/service name is detected, a timestamp-based fallback is used.

---

## Architecture snapshot

- `src/App.tsx`
	- Auth flow
	- WebMap loading
	- Auto embeddings check/generation
	- Assistant UI wiring
- `src/agents/CreateFeatureLayerAgent.ts`
	- LangGraph workflow
	- Prompt parsing (LLM + deterministic fallback)
	- Feature service creation call path
- `src/utils/arcgisOnline.ts`
	- OAuth credential handling
	- WebMap resource checks/uploads
	- Hosted feature service REST operations

---

## Troubleshooting

- **Missing sign-in button behavior**: verify `VITE_ARCGIS_OAUTH_APP_ID` and restart dev server.
- **OAuth works but map won't load**: confirm WebMap ID and sharing permissions.
- **Data exploration answers are weak**: regenerate embeddings from panel header.
- **Create layer fails**: confirm account privileges for hosted feature layer creation.

---

## Scripts

- `npm run dev` – start development server
- `npm run build` – production build
- `npm run preview` – preview production build locally

