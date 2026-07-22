# Artisanal Fishing Density &dash; Madagascar

## Overview
Developed as part of a Master 2 research project at the MARBEC laboratory, this application visualizes spatial predictions of artisanal fishing effort in Madagascar using satellite imagery and deep learning. It addresses the statistical invisibility of traditional wooden canoes (pirogues) by mapping detection densities, filterable object classes, and marine conservation areas across the coastline. 

Explore the live web application here: [https://thomas-aub.github.io/Fishery-viz/](https://thomas-aub.github.io/Fishery-viz/)

---

## Code Structure

The repository is organized as a lightweight, frontend-only D3.js mapping application:
* **`index.html`**: The main entry point containing the user interface layout, top navigation, sidebar controls, filters, and the descriptive study info panel.
* **`map.js`**: Core visualization script handling data ingestion, coordinate projections (UTM to WGS84 conversions), density and point rendering layers, zoom/pan behaviours, and user interactions.
* **`style.css`**: Complete stylesheet managing the visual theme, component layouts, responsive design, and sidebar panels.
* **`data/`**: Directory containing dataset files:
  * `Consolidated_objects.json`: Detected bounding boxes and object classification data.
  * `Images_metadata.json`: Satellite image footprints and surface area calculations.
  * `utils/`: Auxiliary spatial layers including country boundaries, regions, main ports, and marine conservation areas.

---

## Running Locally

Because the application fetches local JSON, GeoJSON, and CSV files via D3, modern web browsers restrict direct local file access (`file://`) due to CORS security policies. You must run it through a local HTTP server.

1. Clone or download the repository to your local machine.
2. Open a terminal and navigate to the project's root folder.
3. Start a lightweight local server:
   * **Using Python:**
     ```bash
     python -m http.server 8000
     ```
   * **Using Node.js:**
     ```bash
     npx http-server
     ```
4. Open your browser and go to `http://localhost:8000`.