// =============================================================================
// CONFIG
// =============================================================================

const OBJECTS_URL = "./data/Consolidated_objects.json";
const IMAGES_URL = "./data/Images_metadata.json";

const IMAGE_UTM_ZONE = 39;
const IMAGE_UTM_HEMISPHERE = "S";

const COUNTRY_BOUNDARY_ENABLED = true;
const COUNTRY_BOUNDARY_URL = "./data/utils/mada_boundaries.geojson";

const REGIONS_ENABLED = true;
const REGIONS_URL = "./data/utils/regions.geojson";
const REGION_COUNTRY_CODE = "MDG";

const PORTS_ENABLED = true;
const PORTS_URL = "./data/utils/main_ports.csv";
const PORT_DOT_RADIUS = 7;
const PORT_LABEL_FONT_SIZE = 13;

const MARINE_AREAS_URL = "./data/utils/Madagascar_Marine_Conservation_Areas.geojson";

const CLASSES = {
  0: { name: "Pirogue", color: "#2563eb" },
  1: { name: "Small motorboat", color: "#d97706" },
  2: { name: "Other boat", color: "#059669" },
};

const DENSITY_COLOR_RAMP = d3.interpolateRgbBasis([
  "#fef9c3",
  "#fde68a",
  "#fb923c",
  "#ef4444",
  "#b91c1c",
]);
const DENSITY_BIN_COUNT = 7;
const DENSITY_EMPTY_COLOR = "#e5e7eb";

const POINT_RADIUS = 2.2;
const PADDING_RATIO = 0.12;

// =============================================================================
// GEO HELPERS
// =============================================================================

function utmToWgs84(easting, northing, zone, hemisphere) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ePrime2 = e2 / (1 - e2);

  let y = northing;
  if (hemisphere === "S") y -= 10000000.0;
  const x = easting - 500000.0;

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

  const lonOrigin = (zone - 1) * 6 - 180 + 3;
  return [
    lonOrigin + (lon * 180) / Math.PI,
    (lat * 180) / Math.PI,
  ];
}

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

let objects = [];
let images = [];
let activeView = "density";
let activeClassIds = new Set(Object.keys(CLASSES).map(Number));
let activeProximityFilter = "all";
let minConfidence = 0.20;

const container = document.getElementById("map-container");
const svg = d3.select("#map");
const tooltip = d3.select("#tooltip");

const gRoot = svg.append("g").attr("class", "root");
const gBasemapCountries = gRoot.append("g").attr("class", "basemap-countries");
const gBasemapProvinces = gRoot.append("g").attr("class", "basemap-provinces");
const gMarineAreas = gRoot.append("g").attr("class", "marine-areas");
const gBoxes = gRoot.append("g").attr("class", "boxes");
const gPoints = gRoot.append("g").attr("class", "points");
const gPorts = gRoot.append("g").attr("class", "ports");

let marineAreasGeo = null;
let width = 0;
let height = 0;
let projection = null;
let path = null;
let zoomBehavior = null;
let ports = [];

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
      areaKm2: img.area !== undefined ? img.area : utmRectangleAreaKm2(img.coordinates),
    };
  }).filter((img) => img.areaKm2 > 0);

  return true;
}

function recomputeFilteredData() {
  const visibleObjects = objects.filter((o) => {
    if (!activeClassIds.has(o.class_id)) return false;
    if (o.confidence !== undefined && o.confidence < minConfidence) return false;
    if (activeProximityFilter !== "all") {
      if (!o[activeProximityFilter]) return false;
    }
    return true;
  });

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

function initProximityFilter() {
  d3.selectAll('input[name="proximity"]').on("change", function () {
    activeProximityFilter = this.value;
    renderActiveView();
  });
}

function initConfidenceFilter() {
  const slider = document.getElementById("confidence-slider");
  const valueDisplay = document.getElementById("confidence-value");
  if (!slider) return;

  function updateSliderBackground(val) {
    const percent = val * 100;
    slider.style.background = `linear-gradient(to right, #fb923c ${percent}%, var(--land-border) ${percent}%)`;
  }

  updateSliderBackground(minConfidence);

  slider.addEventListener("input", function () {
    minConfidence = parseFloat(this.value);
    if (valueDisplay) {
      valueDisplay.textContent = minConfidence.toFixed(2);
    }
    updateSliderBackground(minConfidence);
    renderActiveView();
  });
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

// Variable to keep track of the currently selected image target for QGIS
let selectedImageForQgis = null;

function initQgisModal() {
  const modal = document.getElementById("qgis-modal");
  const modalText = document.getElementById("qgis-modal-text");
  const btnYes = document.getElementById("qgis-modal-yes");
  const btnNo = document.getElementById("qgis-modal-no");

  btnNo.addEventListener("click", () => {
    modal.classList.add("hidden");
    selectedImageForQgis = null;
  });

  btnYes.addEventListener("click", async () => {
    modal.classList.add("hidden");
    if (!selectedImageForQgis) return;

    try {
      // Calls a local Python bridge server running on your machine
      const response = await fetch("http://localhost:5000/open-qgis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: selectedImageForQgis })
      });
      
      const result = await response.json();
      if (!response.ok) {
        alert("Error opening QGIS: " + (result.error || "Unknown error"));
      }
    } catch (err) {
      console.error("Failed to connect to local QGIS bridge:", err);
      alert("Could not connect to the local bridge server. Make sure your local Python server is running!");
    }
    
    selectedImageForQgis = null;
  });
}

// Inside your renderDensityView function, update the .on("click", ...) handler:
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
    .on("mouseleave", hideTooltip)
    .on("click", function(event, d) {
      // Trigger the custom modal popup on click
      selectedImageForQgis = d.filename;
      const modal = document.getElementById("qgis-modal");
      const modalText = document.getElementById("qgis-modal-text");
      modalText.textContent = `Do you want to open "${d.filename}" in QGIS?`;
      modal.classList.remove("hidden");
    });

  buildDensityLegend(densityScale);
}
// =============================================================================
// RENDERING — POINT VIEW
// =============================================================================

function renderPointsView(visibleObjects) {
  gBoxes.selectAll("path").attr("fill-opacity", 0).style("pointer-events", "none");

  const transform = d3.zoomTransform(svg.node());
  const k = transform ? transform.k : 1;

  gPoints
    .selectAll("circle")
    .data(visibleObjects)
    .join("circle")
    .attr("class", "detection-point")
    .attr("cx", (d) => projection([d.coords.x, d.coords.y])[0])
    .attr("cy", (d) => projection([d.coords.x, d.coords.y])[1])
    .attr("r", POINT_RADIUS / k)
    .attr("stroke-width", 0.5 / k)
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

  const [boundaryGeo, regionsGeo, portsRows, marineAreasGeoJson] = await Promise.all([
    COUNTRY_BOUNDARY_ENABLED ? d3.json(COUNTRY_BOUNDARY_URL).catch(() => null) : Promise.resolve(null),
    REGIONS_ENABLED ? d3.json(REGIONS_URL).catch(() => null) : Promise.resolve(null),
    PORTS_ENABLED ? d3.csv(PORTS_URL).catch(() => []) : Promise.resolve([]),
    d3.json(MARINE_AREAS_URL).catch(() => null),
  ]);
  marineAreasGeo = marineAreasGeoJson;
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

  if (marineAreasGeo) {
    gMarineAreas
      .selectAll("path.marine-area-polygon")
      .data(marineAreasGeo.features)
      .join("path")
      .attr("class", "marine-area-polygon")
      .attr("d", path)
      .append("title")
      .text(d => `${d.properties.NAME || 'Protected Area'} (${d.properties.DESIG_ENG || 'Conservation Area'})`);
  }

  d3.select("#toggle-marine-areas").on("change", function() {
    gMarineAreas.style("display", this.checked ? null : "none");
  });
  
  gMarineAreas.style("display", null);

  buildClassFilter();
  initConfidenceFilter();
  initProximityFilter();
  initViewSwitch();
  initQgisModal();
  renderActiveView();

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

  zoomBehavior = d3.zoom()
    .scaleExtent([0.6, 60])
    .on("zoom", (event) => {
      gRoot.attr("transform", event.transform);
      const k = event.transform.k;
      gBoxes.selectAll("path").attr("stroke-width", 0.6 / k);
      gBasemapCountries.selectAll(".country-border").attr("stroke-width", 1 / k);
      gBasemapProvinces.selectAll("path").attr("stroke-width", 0.6 / k);
      gMarineAreas.selectAll(".marine-area-polygon").attr("stroke-width", 1.2 / k); 
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
  initNav();
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
  gMarineAreas.selectAll("path.marine-area-polygon").attr("d", path);
  gBoxes.selectAll("path").attr("d", (d) => path(d.geojson));

  const transform = d3.zoomTransform(svg.node());
  const k = transform ? transform.k : 1;

  gPoints
    .selectAll("circle")
    .attr("cx", (d) => projection([d.coords.x, d.coords.y])[0])
    .attr("cy", (d) => projection([d.coords.x, d.coords.y])[1])
    .attr("r", POINT_RADIUS / k)
    .attr("stroke-width", 0.5 / k);

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
});

// =============================================================================
// TOP NAV + INFO PANEL TOGGLE
// =============================================================================

function initNav() {
  const navMap = document.getElementById("nav-map");
  const navInfo = document.getElementById("nav-info");
  const infoPanel = document.getElementById("info-panel");
  const pageTitle = document.getElementById("page-title");

  function showMapMode() {
    navMap.classList.add("active");
    navInfo.classList.remove("active");
    infoPanel.classList.add("hidden");
    pageTitle.classList.remove("faded");
  }

  function showInfoMode() {
    navMap.classList.remove("active");
    navInfo.classList.add("active");
    infoPanel.classList.remove("hidden");
    pageTitle.classList.add("faded");
  }

  navMap.addEventListener("click", showMapMode);
  navInfo.addEventListener("click", showInfoMode);
}

init();