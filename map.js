// =============================================================================
// CONFIG
// =============================================================================

const OBJECTS_URL = "./data/Consolidated_objects.json";
const IMAGES_URL = "./data/Images_metadata.json";

// Image footprints are stored in this projected CRS (UTM zone 39S, covers
// the Madagascar coast). Detected-object coordinates are already WGS84
// lon/lat, so footprints are the only geometry that needs reprojecting.
// If a future export switches zones, update both constants together.
const IMAGE_UTM_ZONE = 39;
const IMAGE_UTM_HEMISPHERE = "S";

// Local Madagascar boundary (island outline), replacing the previous
// CDN-hosted world topojson. No external network call — this is the primary
// base layer, drawn as an outline only (no fill), per data/utils/.
const COUNTRY_BOUNDARY_ENABLED = true;
const COUNTRY_BOUNDARY_URL = "./data/utils/mada_boundaries.geojson";

// Optional: local admin-1 / region boundaries (light gray). No reliable,
// lightweight, worldwide admin-1 dataset can be safely hotlinked client-side
// (large files, or Git-LFS-backed URLs that browsers can't follow), so this
// layer is generated once locally instead of fetched from a public CDN.
//
// Run `python fetch_regions.py` once (see that file) to generate
// ./map/regions.geojson. The file may contain neighbouring countries too
// (e.g. Tanzania, Mozambique) — REGION_COUNTRY_CODE filters it down to just
// the one we're displaying.
const REGIONS_ENABLED = true;
const REGIONS_URL = "./data/utils/regions.geojson";
const REGION_COUNTRY_CODE = "MDG"; // geoBoundaries shapeGroup (ISO3) to keep

// Main ports (CSV: Port_Name, Latitude, Longitude, Port_Type).
const PORTS_ENABLED = true;
const PORTS_URL = "./data/utils/main_ports.csv";
// Ports are sized well above detection points (POINT_RADIUS = 2.2px) so
// they read as a distinct, always-visible layer at any zoom level,
// including the fully-zoomed-out country view (k=1 at reset).
const PORT_DOT_RADIUS = 7; // px, kept constant across zoom levels
const PORT_LABEL_FONT_SIZE = 13; // px, kept constant across zoom levels

// Detected object classes. class_id is the only key present in the raw
// data — names/colors are supplied here since the source JSON carries no
// label field.
const CLASSES = {
  0: { name: "Pirogue", color: "#2563eb" },
  1: { name: "Small motorboat", color: "#d97706" },
  2: { name: "Other boat", color: "#059669" },
};

// Density choropleth: pale yellow (least dense) -> strong red (most dense),
// split into 7 quantile bins (see buildDensityScale).
const DENSITY_COLOR_RAMP = d3.interpolateRgbBasis([
  "#fef9c3", // pale yellow
  "#fde68a",
  "#fb923c",
  "#ef4444",
  "#b91c1c", // strong red
]);
const DENSITY_BIN_COUNT = 7;
const DENSITY_EMPTY_COLOR = "#e5e7eb"; // neutral gray for zero-count images

const POINT_RADIUS = 2.2; // px, kept constant across zoom levels
const PADDING_RATIO = 0.12; // extra breathing room around the data extent

// =============================================================================
// GEO HELPERS
// =============================================================================

// Minimal closed-form UTM -> WGS84 inverse projection (Karney/Snyder series),
// scoped to a single fixed zone/hemisphere (see IMAGE_UTM_ZONE above). A full
// projection library (e.g. proj4js) would be overkill for reprojecting ~300
// static rectangle corners once at load time.
function utmToWgs84(easting, northing, zone, hemisphere) {
  const a = 6378137.0; // WGS84 semi-major axis (m)
  const f = 1 / 298.257223563; // WGS84 flattening
  const k0 = 0.9996; // UTM scale factor
  const e2 = f * (2 - f);
  const ePrime2 = e2 / (1 - e2);

  let y = northing;
  if (hemisphere === "S") y -= 10000000.0; // false northing for southern zones
  const x = easting - 500000.0; // false easting

  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const M = y / k0;
  const mu =
    M /
    (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const T1 = tanPhi1 * tanPhi1;
  const C1 = ePrime2 * cosPhi1 * cosPhi1;
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = x / (N1 * k0);

  const lat =
    phi1 -
    (N1 * tanPhi1 / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ePrime2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ePrime2 - 3 * C1 * C1) *
          D ** 6) /
          720);

  const lon =
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ePrime2 + 24 * T1 * T1) *
        D ** 5) /
        120) /
    cosPhi1;

  const lonOrigin = (zone - 1) * 6 - 180 + 3; // central meridian of the zone
  return [
    lonOrigin + (lon * 180) / Math.PI,
    (lat * 180) / Math.PI,
  ];
}

// Fallback plain width x height ground area calculation in meters
function utmRectangleAreaKm2(coords) {
  const { top_left, top_right, bottom_left } = coords;
  const widthM = Math.hypot(top_right[0] - top_left[0], top_right[1] - top_left[1]);
  const heightM = Math.hypot(bottom_left[0] - top_left[0], bottom_left[1] - top_left[1]);
  return (widthM * heightM) / 1e6;
}

function imageFootprintToGeoJson(coords) {
  const corners = ["top_left", "top_right", "bottom_right", "bottom_left", "top_left"];
  const ring = corners.map((key) =>
    utmToWgs84(coords[key][0], coords[key][1], IMAGE_UTM_ZONE, IMAGE_UTM_HEMISPHERE)
  );
  return { type: "Polygon", coordinates: [ring] };
}

// =============================================================================
// STATE
// =============================================================================

const container = document.getElementById("map-container");
const svg = d3.select("#map");
const tooltip = d3.select("#tooltip");

const gRoot = svg.append("g").attr("class", "root");
const gBasemapCountries = gRoot.append("g").attr("class", "basemap-countries");
const gBasemapProvinces = gRoot.append("g").attr("class", "basemap-provinces");
const gBoxes = gRoot.append("g").attr("class", "boxes");
const gPoints = gRoot.append("g").attr("class", "points");
const gPorts = gRoot.append("g").attr("class", "ports");

let width = 0;
let height = 0;
let projection = null;
let path = null;
let zoomBehavior = null;
let ports = [];

let objects = []; // raw detections, WGS84 lon/lat
let images = []; // image footprints with precomputed geometry + area
let activeView = "density"; // "density" | "points"
let activeClassIds = new Set(Object.keys(CLASSES).map(Number));

function getSize() {
  const rect = container.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  svg.attr("width", width).attr("height", height);
}

// =============================================================================
// DATA LOADING & PREP
// =============================================================================

function showFatalError(message) {
  container.insertAdjacentHTML("beforeend", `<div class="fatal-error">${message}</div>`);
}

function stripExtension(filename) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

async function loadData() {
  let rawObjects, rawImages;
  try {
    [rawObjects, rawImages] = await Promise.all([
      d3.json(OBJECTS_URL),
      d3.json(IMAGES_URL),
    ]);
  } catch (err) {
    showFatalError(
      `Could not load <code>${OBJECTS_URL}</code> or <code>${IMAGES_URL}</code> ` +
        `(404 or invalid JSON). Confirm both files exist under <code>./data/</code>.`
    );
    console.error("[map.js] Failed to load required data files:", err);
    return false;
  }

  objects = rawObjects;

  images = rawImages.map((img) => {
    const geojson = imageFootprintToGeoJson(img.coordinates);
    return {
      filename: img.filename,
      stem: stripExtension(img.filename),
      geojson,
      // Directly consume the precomputed area from Python, with fallback to box calculation
      areaKm2: img.area !== undefined ? img.area : utmRectangleAreaKm2(img.coordinates),
    };
  });

  return true;
}

// Recomputes everything that depends on the active class filter: per-image
// counts/densities and the flat list of visible points. Called once on load
// and again whenever a filter checkbox changes.
function recomputeFilteredData() {
  const visibleObjects = objects.filter((o) => activeClassIds.has(o.class_id));

  const countsByImage = new Map();
  for (const obj of visibleObjects) {
    countsByImage.set(obj.original_image, (countsByImage.get(obj.original_image) || 0) + 1);
  }

  for (const img of images) {
    const count = countsByImage.get(img.stem) || 0;
    img.count = count;
    img.densityKm2 = img.areaKm2 > 0 ? count / img.areaKm2 : 0;
  }

  return visibleObjects;
}

// =============================================================================
// LEGEND
// =============================================================================

function buildDensityLegend(densityScale) {
  const legend = d3.select("#legend");
  legend.html("");
  legend.append("div").attr("class", "legend-label").text("Detection density (obj/km²)");

  const colors = densityScale.range();
  const stops = [];
  colors.forEach((color, i) => {
    const start = (i / colors.length) * 100;
    const end = ((i + 1) / colors.length) * 100;
    stops.push(`${color} ${start}%`, `${color} ${end}%`);
  });

  legend
    .append("div")
    .attr("class", "legend-gradient")
    .style("background", `linear-gradient(to right, ${stops.join(", ")})`);

  const [domainMin, domainMax] = d3.extent(densityScale.domain());
  const scaleRow = legend.append("div").attr("class", "legend-scale");
  scaleRow.append("span").text((domainMin ?? 0).toFixed(2));
  scaleRow.append("span").text((domainMax ?? 0).toFixed(2));

  const portRow = legend.append("div").attr("class", "legend-port-item");
  portRow.append("div").attr("class", "legend-port-dot");
  portRow.append("span").text("Main ports");
}

function buildPointsLegend() {
  const legend = d3.select("#legend");
  legend.html("");
  legend.append("div").attr("class", "legend-label").text("Detected class");

  for (const [classId, meta] of Object.entries(CLASSES)) {
    const row = legend.append("div").attr("class", "legend-port-item");
    row.append("div").attr("class", "legend-port-dot").style("background-color", meta.color);
    row.append("span").text(meta.name);
  }
}

// =============================================================================
// CLASS FILTER PANEL
// =============================================================================

function buildClassFilter() {
  const countsByClass = new Map();
  for (const obj of objects) {
    countsByClass.set(obj.class_id, (countsByClass.get(obj.class_id) || 0) + 1);
  }

  const list = d3.select("#class-filter-list");
  list.html("");

  const items = list
    .selectAll(".filter-item")
    .data(Object.entries(CLASSES).map(([id, meta]) => ({ id: Number(id), ...meta })))
    .join("label")
    .attr("class", "filter-item")
    .style("--swatch-color", (d) => d.color);

  items
    .append("input")
    .attr("type", "checkbox")
    .property("checked", (d) => activeClassIds.has(d.id))
    .on("change", function (event, d) {
      if (this.checked) activeClassIds.add(d.id);
      else activeClassIds.delete(d.id);
      renderActiveView();
    });

  items.append("span").attr("class", "filter-swatch");
  items.append("span").attr("class", "filter-name").text((d) => d.name);
  items
    .append("span")
    .attr("class", "filter-count")
    .text((d) => (countsByClass.get(d.id) || 0).toLocaleString());
}

// =============================================================================
// TOOLTIPS
// =============================================================================

function showDensityTooltip(event, d) {
  const [mx, my] = d3.pointer(event, container);
  const body =
    d.count > 0
      ? `<div class="tooltip-count">${d.densityKm2.toFixed(2)} obj/km²</div>
         <div class="tooltip-sub">${d.count.toLocaleString()} object${d.count === 1 ? "" : "s"} over ${d.areaKm2.toFixed(2)} km²</div>`
      : `<div class="tooltip-count">0 objects</div>
         <div class="tooltip-sub">${d.areaKm2.toFixed(2)} km² scanned, no matching detections</div>`;
  tooltip
    .classed("hidden", false)
    .style("left", `${mx}px`)
    .style("top", `${my}px`)
    .html(`<div class="tooltip-title">${d.filename}</div>${body}`);
}

function moveTooltip(event) {
  const [mx, my] = d3.pointer(event, container);
  tooltip.style("left", `${mx}px`).style("top", `${my}px`);
}

function hideTooltip() {
  tooltip.classed("hidden", true);
}

// =============================================================================
// RENDERING — DENSITY VIEW
// =============================================================================

function buildDensityScale(visibleImages) {
  const colors = d3.range(DENSITY_BIN_COUNT).map((i) =>
    DENSITY_COLOR_RAMP(i / (DENSITY_BIN_COUNT - 1))
  );
  const nonEmptyDensities = visibleImages.filter((d) => d.count > 0).map((d) => d.densityKm2);
  return d3.scaleQuantile().domain(nonEmptyDensities).range(colors);
}

function renderDensityView() {
  gPoints.selectAll("*").remove();

  const densityScale = buildDensityScale(images);

  gBoxes
    .selectAll("path")
    .data(images, (d) => d.filename)
    .join("path")
    .attr("class", "density-box")
    .attr("d", (d) => path(d.geojson))
    .attr("fill", (d) => (d.count > 0 ? densityScale(d.densityKm2) : DENSITY_EMPTY_COLOR))
    .attr("fill-opacity", (d) => (d.count > 0 ? 0.82 : 0.35))
    .on("mouseenter", function (event, d) {
      d3.select(this).raise();
      showDensityTooltip(event, d);
    })
    .on("mousemove", moveTooltip)
    .on("mouseleave", hideTooltip);

  buildDensityLegend(densityScale);
}

// =============================================================================
// RENDERING — POINT VIEW
// =============================================================================

function renderPointsView(visibleObjects) {
  gBoxes.selectAll("path").attr("fill-opacity", 0).style("pointer-events", "none");

  gPoints
    .selectAll("circle")
    .data(visibleObjects)
    .join("circle")
    .attr("class", "detection-point")
    .attr("cx", (d) => projection([d.coords.x, d.coords.y])[0])
    .attr("cy", (d) => projection([d.coords.x, d.coords.y])[1])
    .attr("r", POINT_RADIUS)
    .attr("fill", (d) => CLASSES[d.class_id]?.color ?? "#999");

  buildPointsLegend();
}

// =============================================================================
// VIEW ORCHESTRATION
// =============================================================================

function renderActiveView() {
  const visibleObjects = recomputeFilteredData();

  if (activeView === "density") {
    gBoxes.selectAll("path").attr("fill-opacity", null).style("pointer-events", null);
    renderDensityView();
    gPoints.selectAll("*").remove();
  } else {
    renderPointsView(visibleObjects);
  }
}

function initViewSwitch() {
  const btnPoints = document.getElementById("view-points");
  const btnDensity = document.getElementById("view-density");

  function setView(view) {
    activeView = view;
    btnPoints.classList.toggle("active", view === "points");
    btnPoints.setAttribute("aria-pressed", String(view === "points"));
    btnDensity.classList.toggle("active", view === "density");
    btnDensity.setAttribute("aria-pressed", String(view === "density"));
    renderActiveView();
  }

  btnPoints.addEventListener("click", () => setView("points"));
  btnDensity.addEventListener("click", () => setView("density"));
}

// =============================================================================
// INIT
// =============================================================================

async function init() {
  getSize();

  const dataLoaded = await loadData();
  if (!dataLoaded) return;

  const [boundaryGeo, regionsGeo, portsRows] = await Promise.all([
    COUNTRY_BOUNDARY_ENABLED ? d3.json(COUNTRY_BOUNDARY_URL).catch(() => null) : Promise.resolve(null),
    REGIONS_ENABLED ? d3.json(REGIONS_URL).catch(() => null) : Promise.resolve(null),
    PORTS_ENABLED ? d3.csv(PORTS_URL).catch(() => []) : Promise.resolve([]),
  ]);
  ports = portsRows.map((row) => ({
    name: row.Port_Name,
    type: row.Port_Type,
    lon: +row.Longitude,
    lat: +row.Latitude,
  }));

  const extentPolygon = computeExtent(images);

  projection = d3.geoMercator().fitExtent(
    [[16, 16], [width - 16, height - 16]],
    extentPolygon
  );
  path = d3.geoPath(projection);

  // --- Basemap: Madagascar boundary, local file, outline only (no fill) ---
  if (boundaryGeo) {
    const boundaryFeatures =
      boundaryGeo.type === "Topology"
        ? topojson.feature(boundaryGeo, boundaryGeo.objects[Object.keys(boundaryGeo.objects)[0]]).features
        : boundaryGeo.type === "FeatureCollection"
          ? boundaryGeo.features
          : [boundaryGeo];

    gBasemapCountries
      .selectAll("path.country-border")
      .data(boundaryFeatures)
      .join("path")
      .attr("class", "country-border")
      .attr("d", path);
  } else {
    console.warn(`[map.js] Could not load ${COUNTRY_BOUNDARY_URL}.`);
  }

  // --- Basemap: admin-1 regions/provinces (light gray), filtered to REGION_COUNTRY_CODE ---
  if (regionsGeo) {
    const allRegionFeatures =
      regionsGeo.type === "Topology"
        ? topojson.feature(regionsGeo, regionsGeo.objects[Object.keys(regionsGeo.objects)[0]]).features
        : regionsGeo.features;
    const regionFeatures = allRegionFeatures.filter(
      (f) => f.properties?.shapeGroup === REGION_COUNTRY_CODE
    );
    gBasemapProvinces.selectAll("path").data(regionFeatures).join("path").attr("class", "region-border").attr("d", path);
  }

  buildClassFilter();
  initViewSwitch();
  renderActiveView();

  // --- Main ports: small red dot + label, fixed screen-space size ---
  const portGroups = gPorts
    .selectAll("g.port")
    .data(ports)
    .join("g")
    .attr("class", "port")
    .attr("transform", (d) => {
      const [x, y] = projection([d.lon, d.lat]);
      return `translate(${x},${y})`;
    });

  portGroups.append("circle").attr("class", "port-dot").attr("r", PORT_DOT_RADIUS);

  portGroups
    .append("text")
    .attr("class", "port-label")
    .attr("x", PORT_DOT_RADIUS + 7)
    .attr("y", 4)
    .style("font-size", `${PORT_LABEL_FONT_SIZE}px`)
    .text((d) => d.name);

  // --- Zoom / pan ---
  zoomBehavior = d3.zoom()
    .scaleExtent([0.6, 60])
    .on("zoom", (event) => {
      gRoot.attr("transform", event.transform);
      const k = event.transform.k;
      gBoxes.selectAll("path").attr("stroke-width", 0.6 / k);
      gBasemapCountries.selectAll(".country-border").attr("stroke-width", 1 / k);
      gBasemapProvinces.selectAll("path").attr("stroke-width", 0.6 / k);
      gPoints.selectAll("circle").attr("r", POINT_RADIUS / k).attr("stroke-width", 0.5 / k);
      gPorts.selectAll(".port-dot").attr("r", PORT_DOT_RADIUS / k);
      gPorts
        .selectAll(".port-label")
        .style("font-size", `${PORT_LABEL_FONT_SIZE / k}px`)
        .attr("x", (PORT_DOT_RADIUS + 7) / k)
        .attr("y", 4 / k);
    });

  svg.call(zoomBehavior);

  d3.select("#zoom-in").on("click", () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1.6));
  d3.select("#zoom-out").on("click", () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1 / 1.6));
  d3.select("#zoom-reset").on("click", () => svg.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity));

  currentExtentPolygon = extentPolygon;
  initScrollytelling();
}

function computeExtent(imgs) {
  let lonMin = Infinity, latMin = Infinity;
  let lonMax = -Infinity, latMax = -Infinity;
  imgs.forEach((img) => {
    for (const [lon, lat] of img.geojson.coordinates[0]) {
      lonMin = Math.min(lonMin, lon);
      lonMax = Math.max(lonMax, lon);
      latMin = Math.min(latMin, lat);
      latMax = Math.max(latMax, lat);
    }
  });
  const lonPad = (lonMax - lonMin) * PADDING_RATIO || 0.5;
  const latPad = (latMax - latMin) * PADDING_RATIO || 0.5;
  return {
    type: "Polygon",
    coordinates: [[
      [lonMin - lonPad, latMin - latPad],
      [lonMin - lonPad, latMax + latPad],
      [lonMax + lonPad, latMax + latPad],
      [lonMax + lonPad, latMin - latPad],
      [lonMin - lonPad, latMin - latPad],
    ]],
  };
}

let currentExtentPolygon = null;

function redraw() {
  gBasemapCountries.selectAll("path.country-border").attr("d", path);
  gBasemapProvinces.selectAll("path").attr("d", path);
  gBoxes.selectAll("path").attr("d", (d) => path(d.geojson));
  gPoints
    .selectAll("circle")
    .attr("cx", (d) => projection([d.coords.x, d.coords.y])[0])
    .attr("cy", (d) => projection([d.coords.x, d.coords.y])[1]);
  gPorts.selectAll("g.port").attr("transform", (d) => {
    const [x, y] = projection([d.lon, d.lat]);
    return `translate(${x},${y})`;
  });
}

window.addEventListener("resize", () => {
  if (!projection || !currentExtentPolygon) return;
  getSize();
  projection.fitExtent([[16, 16], [width - 16, height - 16]], currentExtentPolygon);
  redraw();
  if (typeof updateScrollyMapWidth === "function") updateScrollyMapWidth();
});

// =============================================================================
// TOP NAV + PAGE CHROME
// =============================================================================

function initNav() {
  const navMap = document.getElementById("nav-map");
  const navInfo = document.getElementById("nav-info");
  const scrolly = document.getElementById("scrolly");
  const pageTitle = document.getElementById("page-title");

  function showMapMode() {
    navMap.classList.add("active");
    navInfo.classList.remove("active");
    scrolly.classList.add("hidden");
    pageTitle.classList.remove("faded");
    if (svg && zoomBehavior) {
      svg.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);
    }
  }

  function showInfoMode() {
    navMap.classList.remove("active");
    navInfo.classList.add("active");
    scrolly.classList.remove("hidden");
    pageTitle.classList.add("faded");
    scrolly.scrollTop = 0;
  }

  navMap.addEventListener("click", showMapMode);
  navInfo.addEventListener("click", showInfoMode);
}

// =============================================================================
// SCROLLYTELLING
// =============================================================================

function flyTo(lon, lat, scale) {
  if (!projection || !svg || !zoomBehavior) return;
  const [x, y] = projection([lon, lat]);
  const k = scale;
  const panelEl = document.getElementById("scrolly-panel");
  const panelWidth = panelEl ? panelEl.getBoundingClientRect().width : 0;
  const visibleCenterX = panelWidth + (width - panelWidth) / 2;
  const targetX = visibleCenterX - x * k;
  const targetY = height / 2 - y * k;

  const transform = d3.zoomIdentity.translate(targetX, targetY).scale(k);
  svg.transition().duration(1100).ease(d3.easeCubicInOut).call(zoomBehavior.transform, transform);
}

function initScrollytelling() {
  initNav();

  const steps = document.querySelectorAll(".scrolly-step");
  if (!steps.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          steps.forEach((s) => s.classList.remove("is-active"));
          entry.target.classList.add("is-active");

          const lon = parseFloat(entry.target.dataset.lon);
          const lat = parseFloat(entry.target.dataset.lat);
          const scale = parseFloat(entry.target.dataset.scale) || 1;
          if (!Number.isNaN(lon) && !Number.isNaN(lat)) {
            flyTo(lon, lat, scale);
          }
        }
      });
    },
    {
      root: document.getElementById("scrolly"),
      threshold: 0.55,
    }
  );

  steps.forEach((step) => observer.observe(step));
}

window.updateScrollyMapWidth = function updateScrollyMapWidth() {
  const active = document.querySelector(".scrolly-step.is-active");
  if (!active) return;
  const lon = parseFloat(active.dataset.lon);
  const lat = parseFloat(active.dataset.lat);
  const scale = parseFloat(active.dataset.scale) || 1;
  if (!Number.isNaN(lon) && !Number.isNaN(lat)) flyTo(lon, lat, scale);
};

init();