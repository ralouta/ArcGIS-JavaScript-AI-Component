import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";
import * as geometryJsonUtils from "@arcgis/core/geometry/support/jsonUtils";

// ── Service config ────────────────────────────────────────────────────────────

const BOUNDARIES_BASE =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/WOR_Boundaries_2024/FeatureServer";

/** Layer IDs inside WOR_Boundaries_2024 */
export const LAYER_REGION = 0;
export const LAYER_COUNTRY = 1;

/** The GraphicsLayer id we manage on the map */
export const MCP_GEO_LAYER_ID = "mcp-geo-results";

// ── Region name normalisation ─────────────────────────────────────────────────

const REGION_ALIASES: Record<string, string> = {
  "middle east":          "Western Asia",
  "east asia":            "Eastern Asia",
  "southeast asia":       "Southeastern Asia",
  "south asia":           "Southern Asia",
  "central asia":         "Central Asia",
  "east africa":          "Eastern Africa",
  "west africa":          "Western Africa",
  "north africa":         "Northern Africa",
  "southern africa":      "Southern Africa",
  "central africa":       "Middle Africa",
  "sub-saharan africa":   "Eastern Africa",
  "europe":               "Western Europe",
  "eastern europe":       "Eastern Europe",
  "western europe":       "Western Europe",
  "northern europe":      "Northern Europe",
  "southern europe":      "Southern Europe",
  "latin america":        "South America",
  "south america":        "South America",
  "central america":      "Central America",
  "north america":        "Northern America",
  "caribbean":            "Caribbean",
  "oceania":              "Australia/New Zealand",
  "australia":            "Australia/New Zealand",
  "caucasus":             "Western Asia",
  "balkans":              "Southern Europe",
};

function normaliseRegionName(raw: string): string {
  return REGION_ALIASES[raw.toLowerCase()] ?? raw;
}

// ── Flag emoji lookup (ISO 3166-1 alpha-2 → emoji) ───────────────────────────
// ISO code from the service's ISO_3DIGIT field is mapped to a flag emoji via
// regional indicator Unicode characters.

const ISO2_FLAGS: Record<string, string> = {
  AF:"🇦🇫",AL:"🇦🇱",DZ:"🇩🇿",AO:"🇦🇴",AR:"🇦🇷",AM:"🇦🇲",AU:"🇦🇺",AT:"🇦🇹",AZ:"🇦🇿",
  BH:"🇧🇭",BD:"🇧🇩",BY:"🇧🇾",BE:"🇧🇪",BO:"🇧🇴",BA:"🇧🇦",BR:"🇧🇷",KH:"🇰🇭",CM:"🇨🇲",
  CA:"🇨🇦",CL:"🇨🇱",CN:"🇨🇳",CO:"🇨🇴",CD:"🇨🇩",HR:"🇭🇷",CU:"🇨🇺",CY:"🇨🇾",CZ:"🇨🇿",
  DK:"🇩🇰",EC:"🇪🇨",EG:"🇪🇬",ET:"🇪🇹",FI:"🇫🇮",FR:"🇫🇷",GE:"🇬🇪",DE:"🇩🇪",GH:"🇬🇭",
  GR:"🇬🇷",GT:"🇬🇹",HT:"🇭🇹",HN:"🇭🇳",HU:"🇭🇺",IN:"🇮🇳",ID:"🇮🇩",IR:"🇮🇷",IQ:"🇮🇶",
  IE:"🇮🇪",IL:"🇮🇱",IT:"🇮🇹",JP:"🇯🇵",JO:"🇯🇴",KZ:"🇰🇿",KE:"🇰🇪",KW:"🇰🇼",KG:"🇰🇬",
  LA:"🇱🇦",LV:"🇱🇻",LB:"🇱🇧",LY:"🇱🇾",LT:"🇱🇹",MY:"🇲🇾",ML:"🇲🇱",MX:"🇲🇽",MD:"🇲🇩",
  MN:"🇲🇳",MA:"🇲🇦",MZ:"🇲🇿",MM:"🇲🇲",NP:"🇳🇵",NL:"🇳🇱",NZ:"🇳🇿",NI:"🇳🇮",NG:"🇳🇬",
  KP:"🇰🇵",NO:"🇳🇴",OM:"🇴🇲",PK:"🇵🇰",PS:"🇵🇸",PA:"🇵🇦",PY:"🇵🇾",PE:"🇵🇪",PH:"🇵🇭",
  PL:"🇵🇱",PT:"🇵🇹",QA:"🇶🇦",RO:"🇷🇴",RU:"🇷🇺",RW:"🇷🇼",SA:"🇸🇦",SN:"🇸🇳",RS:"🇷🇸",
  SG:"🇸🇬",SO:"🇸🇴",ZA:"🇿🇦",KR:"🇰🇷",SS:"🇸🇸",ES:"🇪🇸",LK:"🇱🇰",SD:"🇸🇩",SE:"🇸🇪",
  CH:"🇨🇭",SY:"🇸🇾",TW:"🇹🇼",TJ:"🇹🇯",TZ:"🇹🇿",TH:"🇹🇭",TN:"🇹🇳",TR:"🇹🇷",TM:"🇹🇲",
  AE:"🇦🇪",GB:"🇬🇧",US:"🇺🇸",UY:"🇺🇾",UZ:"🇺🇿",VE:"🇻🇪",VN:"🇻🇳",YE:"🇾🇪",ZW:"🇿🇼",
  UA:"🇺🇦",UG:"🇺🇬",
};

// Map ISO 3-digit → 2-letter for flag lookup
const ISO3_TO_2: Record<string, string> = {
  AFG:"AF",ALB:"AL",DZA:"DZ",AGO:"AO",ARG:"AR",ARM:"AM",AUS:"AU",AUT:"AT",AZE:"AZ",
  BHR:"BH",BGD:"BD",BLR:"BY",BEL:"BE",BOL:"BO",BIH:"BA",BRA:"BR",KHM:"KH",CMR:"CM",
  CAN:"CA",CHL:"CL",CHN:"CN",COL:"CO",COD:"CD",HRV:"HR",CUB:"CU",CYP:"CY",CZE:"CZ",
  DNK:"DK",ECU:"EC",EGY:"EG",ETH:"ET",FIN:"FI",FRA:"FR",GEO:"GE",DEU:"DE",GHA:"GH",
  GRC:"GR",GTM:"GT",HTI:"HT",HND:"HN",HUN:"HU",IND:"IN",IDN:"ID",IRN:"IR",IRQ:"IQ",
  IRL:"IE",ISR:"IL",ITA:"IT",JPN:"JP",JOR:"JO",KAZ:"KZ",KEN:"KE",KWT:"KW",KGZ:"KG",
  LAO:"LA",LVA:"LV",LBN:"LB",LBY:"LY",LTU:"LT",MYS:"MY",MLI:"ML",MEX:"MX",MDA:"MD",
  MNG:"MN",MAR:"MA",MOZ:"MZ",MMR:"MM",NPL:"NP",NLD:"NL",NZL:"NZ",NIC:"NI",NGA:"NG",
  PRK:"KP",NOR:"NO",OMN:"OM",PAK:"PK",PSE:"PS",PAN:"PA",PRY:"PY",PER:"PE",PHL:"PH",
  POL:"PL",PRT:"PT",QAT:"QA",ROU:"RO",RUS:"RU",RWA:"RW",SAU:"SA",SEN:"SN",SRB:"RS",
  SGP:"SG",SOM:"SO",ZAF:"ZA",KOR:"KR",SSD:"SS",ESP:"ES",LKA:"LK",SDN:"SD",SWE:"SE",
  CHE:"CH",SYR:"SY",TWN:"TW",TJK:"TJ",TZA:"TZ",THA:"TH",TUN:"TN",TUR:"TR",TKM:"TM",
  ARE:"AE",GBR:"GB",USA:"US",URY:"UY",UZB:"UZ",VEN:"VE",VNM:"VN",YEM:"YE",ZWE:"ZW",
  UKR:"UA",UGA:"UG",
};

function flagForIso3(iso3?: string): string {
  if (!iso3) return "";
  const iso2 = ISO3_TO_2[iso3.toUpperCase()];
  return iso2 ? (ISO2_FLAGS[iso2] ?? "") : "";
}

// ── Geo entity types ──────────────────────────────────────────────────────────

export interface GeoPoint {
  kind: "point";
  label: string;
  lat: number;
  lon: number;
  description?: string;
}

export interface GeoCountry {
  kind: "country";
  name: string;           // matches NAME field in Layer 1
  description?: string;
}

export interface GeoRegion {
  kind: "region";
  name: string;           // will be normalised to REGION field in Layer 0
  description?: string;
}

export type GeoEntity = GeoPoint | GeoCountry | GeoRegion;

// ── REST query helpers ────────────────────────────────────────────────────────

async function queryLayer(
  layerIndex: number,
  where: string,
  outFields = "*",
): Promise<any[]> {
  const url = `${BOUNDARIES_BASE}/${layerIndex}/query`;
  const params = new URLSearchParams({
    where,
    outFields,
    outSR: "4326",
    f: "json",
    returnGeometry: "true",
  });

  try {
    const res = await fetch(`${url}?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.features) ? json.features : [];
  } catch {
    return [];
  }
}

// ── Symbols ───────────────────────────────────────────────────────────────────

/** Country polygon — semi-opaque teal fill, solid stroke */
const COUNTRY_SYMBOL = {
  type: "simple-fill",
  color: [0, 139, 139, 0.18],
  outline: { color: [0, 139, 139, 0.9], width: 1.8 },
};

/** Region polygon — muted amber, dashed-look via slightly transparent stroke */
const REGION_SYMBOL = {
  type: "simple-fill",
  color: [194, 120, 0, 0.10],
  outline: { color: [194, 120, 0, 0.80], width: 1.4 },
};

/** Point marker — vivid blue with white halo */
const POINT_SYMBOL = {
  type: "simple-marker",
  style: "circle",
  color: [0, 100, 220, 0.92],
  outline: { color: [255, 255, 255, 1], width: 2 },
  size: 13,
};

// ── Popup HTML builders ───────────────────────────────────────────────────────

/** Format a large number with thousands separator */
function fmtNum(n: number | null | undefined): string {
  if (n == null || isNaN(Number(n))) return "—";
  return Number(n).toLocaleString();
}

/** Build a two-column stat row for the popup table */
function row(label: string, value: string | number | null | undefined): string {
  if (value == null || value === "" || value === 0) return "";
  return `<tr><td style="color:#888;padding:2px 10px 2px 0;white-space:nowrap">${label}</td>
          <td style="font-weight:500">${value}</td></tr>`;
}

function buildCountryPopup(attrs: Record<string, any>): string {
  const flag    = flagForIso3(attrs.ISO_3DIGIT ?? attrs.ISO3 ?? attrs.ISO_CC);
  const name    = attrs.NAME ?? attrs.COUNTRY ?? "";
  const capital = attrs.CAPITAL ?? attrs.CAPNAME ?? "";
  const pop     = attrs.POP ?? attrs.POP_EST ?? attrs.POPULATION;
  const area    = attrs.SQMI ?? attrs.AREA_SQMI ?? attrs.AREASQM;
  const region  = attrs.REGION ?? "";
  const subReg  = attrs.SUBREGION ?? attrs.SUB_REGION ?? "";
  const iso     = attrs.ISO_3DIGIT ?? attrs.ISO3 ?? "";
  const gdp     = attrs.GDP_MD ?? attrs.GDP ?? null;

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);line-height:1.5">
      <div style="font-size:2rem;margin-bottom:4px">${flag}</div>
      <table style="border-collapse:collapse;font-size:0.88rem;min-width:180px">
        ${row("Capital", capital)}
        ${row("Population", fmtNum(pop))}
        ${row("Area", area ? `${fmtNum(area)} sq mi` : null)}
        ${row("Region", subReg || region)}
        ${row("ISO code", iso)}
        ${row("GDP (USD M)", gdp ? fmtNum(gdp) : null)}
      </table>
    </div>`;
}

function buildRegionPopup(attrs: Record<string, any>): string {
  const regionName  = attrs.REGION ?? "";
  const subReg      = attrs.SUBREGION ?? attrs.CONTINENT ?? "";
  const countryName = attrs.NAME ?? "";
  const pop         = attrs.POP ?? attrs.POP_EST ?? attrs.POPULATION;
  const area        = attrs.SQMI ?? attrs.AREA_SQMI ?? attrs.AREASQM;

  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);line-height:1.5">
      <table style="border-collapse:collapse;font-size:0.88rem;min-width:180px">
        ${row("Country", countryName)}
        ${row("Sub-region", subReg)}
        ${row("Region", regionName)}
        ${row("Population", fmtNum(pop))}
        ${row("Area", area ? `${fmtNum(area)} sq mi` : null)}
      </table>
    </div>`;
}

function buildPointPopup(pt: GeoPoint): string {
  return `
    <div style="font-family:var(--calcite-sans-family,sans-serif);font-size:0.88rem;line-height:1.5">
      <table style="border-collapse:collapse;min-width:160px">
        ${row("Lat / Lon", `${pt.lat.toFixed(4)}°, ${pt.lon.toFixed(4)}°`)}
        ${pt.description ? `<tr><td colspan="2" style="padding-top:6px">${pt.description}</td></tr>` : ""}
      </table>
    </div>`;
}

// ── Graphic factories ─────────────────────────────────────────────────────────

function countryFeatureToGraphic(feature: any): Graphic | null {
  if (!feature?.geometry) return null;

  let geometry: any;
  try {
    geometry = geometryJsonUtils.fromJSON({
      ...feature.geometry,
      spatialReference: { wkid: 4326 },
    });
  } catch {
    return null;
  }

  const attrs = feature.attributes ?? {};
  const flag  = flagForIso3(attrs.ISO_3DIGIT ?? attrs.ISO3 ?? attrs.ISO_CC);
  const name  = attrs.NAME ?? "Country";

  return new Graphic({
    geometry,
    symbol: COUNTRY_SYMBOL as any,
    attributes: { ...attrs, _displayName: `${flag} ${name}`.trim() },
    popupTemplate: {
      title: `${flag} {NAME}`,
      content: buildCountryPopup(attrs),
    } as any,
  });
}

function regionFeatureToGraphic(feature: any): Graphic | null {
  if (!feature?.geometry) return null;

  let geometry: any;
  try {
    geometry = geometryJsonUtils.fromJSON({
      ...feature.geometry,
      spatialReference: { wkid: 4326 },
    });
  } catch {
    return null;
  }

  const attrs  = feature.attributes ?? {};
  const region = attrs.REGION ?? "Region";
  const name   = attrs.NAME ?? "";

  return new Graphic({
    geometry,
    symbol: REGION_SYMBOL as any,
    attributes: { ...attrs },
    popupTemplate: {
      title: name ? `${name} — ${region}` : region,
      content: buildRegionPopup(attrs),
    } as any,
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render a list of geographic entities onto the active ArcGIS MapView.
 * Replaces the previous MCP geo layer each call.
 */
export async function renderMcpGeoEntities(
  entities: GeoEntity[],
): Promise<void> {
  if (!entities.length) return;

  const mapEl = document.querySelector("#main-map") as any;
  const view: any = mapEl?.view;
  if (!view?.map) return;

  // Replace any previous MCP geo layer.
  const old = view.map.findLayerById(MCP_GEO_LAYER_ID);
  if (old) view.map.remove(old);

  const layer = new GraphicsLayer({
    id: MCP_GEO_LAYER_ID,
    title: "MCP Results",
    listMode: "hide",
  });
  view.map.add(layer);

  const countries = entities.filter((e): e is GeoCountry => e.kind === "country");
  const regions   = entities.filter((e): e is GeoRegion  => e.kind === "region");
  const points    = entities.filter((e): e is GeoPoint   => e.kind === "point");

  // ── Countries (Layer 1, all fields) ──────────────────────────────────────
  if (countries.length) {
    const list = countries
      .map((c) => `'${c.name.replace(/'/g, "''")}'`)
      .join(",");
    const features = await queryLayer(LAYER_COUNTRY, `NAME IN (${list})`);
    for (const feat of features) {
      const g = countryFeatureToGraphic(feat);
      if (g) layer.add(g);
    }
  }

  // ── Regions (Layer 0, all fields) ────────────────────────────────────────
  if (regions.length) {
    const normalised = regions.map((r) => ({
      ...r,
      normalised: normaliseRegionName(r.name),
    }));
    const list = normalised
      .map((r) => `'${r.normalised.replace(/'/g, "''")}'`)
      .join(",");
    const features = await queryLayer(LAYER_REGION, `REGION IN (${list})`);
    for (const feat of features) {
      const g = regionFeatureToGraphic(feat);
      if (g) layer.add(g);
    }
  }

  // ── Points ────────────────────────────────────────────────────────────────
  for (const pt of points) {
    const g = new Graphic({
      geometry: new Point({ latitude: pt.lat, longitude: pt.lon }),
      symbol: POINT_SYMBOL as any,
      attributes: { name: pt.label },
      popupTemplate: {
        title: `📍 {name}`,
        content: buildPointPopup(pt),
      } as any,
    });
    layer.add(g);
  }

  // ── Navigate to the rendered features ────────────────────────────────────
  const allGraphics = (layer.graphics as any).toArray?.() ?? [];
  if (allGraphics.length) {
    try {
      await view.goTo(allGraphics, { animate: true, duration: 1200 });
    } catch {
      // goTo may fail if the view is not ready; ignore silently.
    }
  }
}

/** Remove the MCP geo layer from the map (call on conversation reset etc.). */
export function clearMcpGeoLayer(): void {
  const mapEl = document.querySelector("#main-map") as any;
  const view: any = mapEl?.view;
  if (!view?.map) return;
  const old = view.map.findLayerById(MCP_GEO_LAYER_ID);
  if (old) view.map.remove(old);
}
