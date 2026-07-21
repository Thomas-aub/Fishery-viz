// =============================================================================
// CONFIG
// =============================================================================

const DATA_URL = "./map/density_map_data.json";
// Natural Earth topojson served over a reliable CDN. We only ever draw ONE
// feature from this file (see COUNTRY_NAME below) — fetching the whole file
// costs one small download, but rendering is filtered down before any DOM
// nodes are created, which is what actually matters for performance: the
// unfiltered version was building/painting ~180 country polygons plus a
// world-wide shared-border mesh (thousands of line segments) on every load,
// most of it thousands of km outside the visible viewport.
const WORLD_COUNTRIES_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const COUNTRY_NAME = "Madagascar"; // must match `properties.name` in the topojson

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
const REGIONS_URL = "./map/regions.geojson";
const REGION_COUNTRY_CODE = "MDG"; // geoBoundaries shapeGroup (ISO3) to keep

// Main ports (CSV: Port_Name, Latitude, Longitude, Port_Type).
const PORTS_ENABLED = true;
const PORTS_URL = "./map/main_ports.csv";
const PORT_DOT_RADIUS = 4; // px, kept constant across zoom levels
const PORT_LABEL_FONT_SIZE = 11; // px, kept constant across zoom levels

// Dégradé sur mesure : du bleu pâle (moins dense) vers le rouge intense (plus dense)
const COLOR_RAMP = d3.interpolateRgbBasis([
  "#e0f3f8", // Bleu pâle
  "#fee090", // Jaune clair (transition)
  "#fdae61", // Orange
  "#d73027", // Rouge
  "#a50026"  // Rouge très intense/sombre
]);
const PADDING_RATIO = 0.12; // extra breathing room around the data extent

// =============================================================================

const container = document.getElementById("map-container");
const svg = d3.select("#map");
const tooltip = d3.select("#tooltip");

const gRoot = svg.append("g").attr("class", "root");
const gBasemapCountries = gRoot.append("g").attr("class", "basemap-countries");
const gBasemapProvinces = gRoot.append("g").attr("class", "basemap-provinces");
const gBoxes = gRoot.append("g").attr("class", "boxes");
const gPorts = gRoot.append("g").attr("class", "ports");

let width = 0;
let height = 0;
let projection = null;
let path = null;
let zoomBehavior = null;
let colorScale = null;
let ports = [];
let baseScale = 1; // the zoom transform's k at "fit to Madagascar" (k=1 equivalent)

function getSize() {
  const rect = container.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  svg.attr("width", width).attr("height", height);
}

function computeExtent(images) {
  let lonMin = Infinity, latMin = Infinity;
  let lonMax = -Infinity, latMax = -Infinity;
  images.forEach((img) => {
    const [x0, y0, x1, y1] = img.bbox;
    lonMin = Math.min(lonMin, x0);
    lonMax = Math.max(lonMax, x1);
    latMin = Math.min(latMin, y0);
    latMax = Math.max(latMax, y1);
  });
  const lonPad = (lonMax - lonMin) * PADDING_RATIO || 0.5;
  const latPad = (latMax - latMin) * PADDING_RATIO || 0.5;
  // Counter-clockwise winding (see bboxToPolygon) — required for
  // d3.geoBounds/fitExtent to read this as "the data extent" rather than
  // "the whole sphere minus the data extent".
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

// D3's geo pipeline is spherical: exterior rings must wind counter-clockwise
// when viewed from outside the sphere (right-hand rule, per GeoJSON RFC 7946).
// Winding the wrong way makes d3-geo treat the box as "the whole sphere minus
// this hole," which renders as a giant frame covering the full viewport.
function bboxToPolygon(bbox) {
  const [x0, y0, x1, y1] = bbox;
  return {
    type: "Polygon",
    coordinates: [[
      [x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0],
    ]],
  };
}

function buildLegend(densityMin, densityMax) {
  const legend = d3.select("#legend");
  legend.html("");
  legend.append("div").attr("class", "legend-label").text("Object density (obj/km²)");

  const numClasses = 7;
  const discreteColors = d3.range(numClasses).map(i => COLOR_RAMP(i / (numClasses - 1)));

  // Generate CSS hard stops to represent discrete color bins instead of a smooth gradient
  let gradientStops = [];
  discreteColors.forEach((color, i) => {
    const start = (i / numClasses) * 100;
    const end = ((i + 1) / numClasses) * 100;
    gradientStops.push(`${color} ${start}%`, `${color} ${end}%`);
  });

  legend.append("div")
    .attr("class", "legend-gradient")
    .style("background", `linear-gradient(to right, ${gradientStops.join(", ")})`);

  const scale = legend.append("div").attr("class", "legend-scale");
  scale.append("span").text(densityMin.toFixed(2));
  scale.append("span").text(densityMax.toFixed(2));

  // Ajout de la légende pour les ports
  const portLegend = legend.append("div").attr("class", "legend-port-item");
  portLegend.append("div").attr("class", "legend-port-dot");
  portLegend.append("span").text("Main ports");


}

function showTooltip(event, d) {
  const [mx, my] = d3.pointer(event, container);
  const hasDensity = typeof d.density_km2 === "number" && !Number.isNaN(d.density_km2);
  const densityLine = hasDensity
    ? `<div class="tooltip-count">${d.density_km2.toFixed(2)} obj/km²</div>
       <div class="tooltip-sub">${d.count} object${d.count === 1 ? "" : "s"} over ${(d.area_km2 ?? 0).toFixed(2)} km²</div>`
    : `<div class="tooltip-count">${d.count ?? "?"} object${d.count === 1 ? "" : "s"}</div>
       <div class="tooltip-sub">density unavailable — regenerate density_map_data.json</div>`;
  tooltip
    .classed("hidden", false)
    .style("left", `${mx}px`)
    .style("top", `${my}px`)
    .html(`
      <div class="tooltip-title">${d.name}</div>
      ${densityLine}
    `);
}

function moveTooltip(event) {
  const [mx, my] = d3.pointer(event, container);
  tooltip.style("left", `${mx}px`).style("top", `${my}px`);
}

function hideTooltip() {
  tooltip.classed("hidden", true);
}

// Renders a visible error banner instead of leaving a blank/stale canvas.
// A failed fetch inside init() would otherwise throw silently into the
// console, which is easy to mistake for a rendering bug rather than the
// missing-file issue it usually is.
function showFatalError(message) {
  container.insertAdjacentHTML(
    "beforeend",
    `<div class="fatal-error">${message}</div>`
  );
}

async function init() {
  getSize();

  let data;
  try {
    // DATA_URL is required: without it there is nothing to plot, so this
    // fetch is intentionally NOT caught here and is reported explicitly.
    data = await d3.json(DATA_URL);
  } catch (err) {
    showFatalError(
      `Could not load <code>${DATA_URL}</code> (404 or invalid JSON). ` +
        `Run <code>generate_map_vizu.py</code> and confirm the output path ` +
        `matches DATA_URL in map.js.`
    );
    console.error("[map.js] Failed to load required data file:", DATA_URL, err);
    return;
  }

  const [worldTopo, regionsGeo, portsRows] = await Promise.all([
    d3.json(WORLD_COUNTRIES_URL).catch(() => null),
    REGIONS_ENABLED ? d3.json(REGIONS_URL).catch(() => null) : Promise.resolve(null),
    PORTS_ENABLED ? d3.csv(PORTS_URL).catch(() => []) : Promise.resolve([]),
  ]);
  ports = portsRows.map((row) => ({
    name: row.Port_Name,
    type: row.Port_Type,
    lon: +row.Longitude,
    lat: +row.Latitude,
  }));

  const images = data.images || [];
  const extentPolygon = computeExtent(images);
  currentExtentPolygon = extentPolygon;

  projection = d3.geoMercator().fitExtent(
    [[16, 16], [width - 16, height - 16]],
    extentPolygon
  );
  path = d3.geoPath(projection);

  // --- Basemap: country outline (black), filtered to COUNTRY_NAME only ---
  // Rendering the full ~180-country topology (plus its shared-border mesh)
  // was the main cost on both page-load and pan/zoom; a single country is a
  // handful of path points instead of thousands.
  if (worldTopo) {
    const allCountries = topojson.feature(worldTopo, worldTopo.objects.countries);
    const countryFeature = allCountries.features.find(
      (f) => f.properties?.name === COUNTRY_NAME
    );

    if (countryFeature) {
      gBasemapCountries.append("path")
        .datum(countryFeature)
        .attr("class", "land")
        .attr("d", path);
      gBasemapCountries.append("path")
        .datum(countryFeature)
        .attr("class", "country-border")
        .attr("d", path);
    } else {
      console.warn(`[map.js] COUNTRY_NAME "${COUNTRY_NAME}" not found in world topology.`);
    }
  }

  // --- Basemap: admin-1 regions/provinces (light gray), filtered to REGION_COUNTRY_CODE ---
  if (regionsGeo) {
    const allRegionFeatures = regionsGeo.type === "Topology"
      ? topojson.feature(regionsGeo, regionsGeo.objects[Object.keys(regionsGeo.objects)[0]]).features
      : regionsGeo.features;
    const regionFeatures = allRegionFeatures.filter(
      (f) => f.properties?.shapeGroup === REGION_COUNTRY_CODE
    );
    gBasemapProvinces.selectAll("path")
      .data(regionFeatures)
      .join("path")
      .attr("class", "region-border")
      .attr("d", path);
  }

  // --- Density boxes ---
  // NOTE: despite the "count_min"/"count_max" field names (kept for JSON
  // compatibility with generate_map_vizu.py), these now hold density values
  // in objects/km2, not raw object counts.
  const missingDensity = images.some((d) => typeof d.density_km2 !== "number" || Number.isNaN(d.density_km2));
  if (missingDensity) {
    console.warn(
      "[map.js] Some/all images are missing 'density_km2'. " +
      `${DATA_URL} looks stale — re-run generate_map_vizu.py to regenerate it. ` +
      "Falling back to raw 'count' for coloring in the meantime."
    );
    showFatalError(
      `<code>${DATA_URL}</code> is missing <code>density_km2</code> (looks generated by an ` +
      `older version of <code>generate_map_vizu.py</code>). Re-run the script to regenerate it. ` +
      `Falling back to raw object <code>count</code> for coloring in the meantime.`
    );
  }
  const colorValue = (d) =>
    typeof d.density_km2 === "number" && !Number.isNaN(d.density_km2) ? d.density_km2 : d.count;

  const domainMin = missingDensity ? data.count_min : Math.min(...images.map(colorValue));
  const domainMax = missingDensity ? data.count_max : Math.max(...images.map(colorValue));
  
  // Create an array of 7 distinct colors sampled evenly from the COLOR_RAMP
  const numClasses = 7;
  const discreteColors = d3.range(numClasses).map(i => COLOR_RAMP(i / (numClasses - 1)));

  // Use d3.scaleQuantize to bin the data into the 7 color groups
  // Use d3.scaleQuantile to bin the data into 7 groups with equal number of items (1/7th each)
  const allDensities = images.map(colorValue);
  
  colorScale = d3.scaleQuantile()
    .domain(allDensities)
    .range(discreteColors);

  gBoxes.selectAll("path")
    .data(images)
    .join("path")
    .attr("class", "density-box")
    .attr("d", (d) => path(bboxToPolygon(d.bbox)))
    .attr("fill", (d) => colorScale(colorValue(d)))
    .attr("fill-opacity", 0.82)
    .on("mouseenter", function (event, d) {
      d3.select(this).raise();
      showTooltip(event, d);
    })
    .on("mousemove", moveTooltip)
    .on("mouseleave", hideTooltip);

  buildLegend(domainMin, domainMax);

  // --- Main ports: small red dot + label, fixed screen-space size ---
  const portGroups = gPorts.selectAll("g.port")
    .data(ports)
    .join("g")
    .attr("class", "port")
    .attr("transform", (d) => {
      const [x, y] = projection([d.lon, d.lat]);
      return `translate(${x},${y})`;
    });

  portGroups.append("circle")
    .attr("class", "port-dot")
    .attr("r", PORT_DOT_RADIUS);

  portGroups.append("text")
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
      gPorts.selectAll(".port-dot").attr("r", PORT_DOT_RADIUS / k);
      gPorts.selectAll(".port-label")
        .style("font-size", `${PORT_LABEL_FONT_SIZE / k}px`)
        .attr("x", (PORT_DOT_RADIUS + 7) / k)
        .attr("y", 4 / k);
    });

  svg.call(zoomBehavior);

  d3.select("#zoom-in").on("click", () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1.6));
  d3.select("#zoom-out").on("click", () => svg.transition().duration(250).call(zoomBehavior.scaleBy, 1 / 1.6));
  d3.select("#zoom-reset").on("click", () => svg.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity));

  initScrollytelling();
}

let currentExtentPolygon = null;

function redraw() {
  gBasemapCountries.selectAll("path.land").attr("d", path);
  gBasemapCountries.selectAll("path.country-border").attr("d", path);
  gBasemapProvinces.selectAll("path").attr("d", path);
  gBoxes.selectAll("path").attr("d", (d) => path(bboxToPolygon(d.bbox)));
  gPorts.selectAll("g.port").attr("transform", (d) => {
    const [x, y] = projection([d.lon, d.lat]);
    return `translate(${x},${y})`;
  });
}

window.addEventListener("resize", () => {
  if (!projection || !currentExtentPolygon) return;
  getSize();
  projection.fitExtent(
    [[16, 16], [width - 16, height - 16]],
    currentExtentPolygon
  );
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
    // Snap the map back to the full-country view when leaving the story.
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
// Each <section class="scrolly-step"> carries data-lon/data-lat/data-scale
// describing the map view it corresponds to. As a step crosses the middle of
// the viewport, we fly the D3 zoom transform to center on that coordinate at
// that scale. The scrolly panel sits on the left; the map underneath is left
// full-bleed, so no separate "map width" adjustment is needed — the panel
// simply overlays it.

function flyTo(lon, lat, scale) {
  if (!projection || !svg || !zoomBehavior) return;
  const [x, y] = projection([lon, lat]);
  const k = scale;
  // Center the target point in the visible (non-panel) portion of the screen,
  // i.e. right of the ~38% wide scrolly panel.
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
  // Reserved hook: if the panel width changes on resize while a story step
  // is active, re-run flyTo for the current step so the framing stays correct.
  const active = document.querySelector(".scrolly-step.is-active");
  if (!active) return;
  const lon = parseFloat(active.dataset.lon);
  const lat = parseFloat(active.dataset.lat);
  const scale = parseFloat(active.dataset.scale) || 1;
  if (!Number.isNaN(lon) && !Number.isNaN(lat)) flyTo(lon, lat, scale);
};

init();