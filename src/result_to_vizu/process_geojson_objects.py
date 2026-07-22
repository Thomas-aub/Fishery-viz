import json
import csv
from pathlib import Path
import geopandas as gpd
from shapely.geometry import Point

# --- PARAMETERS ---
GEOJSON_FOLDER = "/mnt/DATA/thomas/data_center/Madagascar/data/inference/geojson"
OUTPUT_JSON = "/mnt/DATA/thomas/data_center/Madagascar/mapping/Consolidated_objects.json"
CSV_MAPPING_FILE = "/mnt/DATA/thomas/data_center/Madagascar/data/inference/tiled/geodata.csv"
BOUNDARY_PATH = "/mnt/DATA/thomas/data_center/Madagascar/mada_boundaries.geojson"
# ------------------

def process_geojson_objects(folder_path: str, output_file: str, csv_file: str, boundary_path: str) -> None:
    """Reads GeoJSONs, computes OBB centers, maps file names, computes coastline proximity flags, and exports data."""
    consolidated_data = []
    folder = Path(folder_path)
    
    # 1. Load the CSV mapping into a dictionary for fast lookups
    tile_to_source = {}
    try:
        with open(csv_file, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                tile_to_source[row["tile_name"]] = row["source_image"]
    except FileNotFoundError:
        print(f"DEBUG ERROR: The CSV mapping file '{csv_file}' was not found.")
        return
    except KeyError as e:
        print(f"DEBUG ERROR: Missing expected column in '{csv_file}'. Ensure headers are 'tile_name' and 'source_image'. Error: {e}")
        return

    # 2. Validate the directory path
    print(f"DEBUG: Looking for folder at: {folder.resolve()}")
    if not folder.exists():
        print(f"DEBUG ERROR: The folder {folder_path} does NOT exist.")
        return

    # 3. Load boundaries and create metric buffers (following borders.py logic)
    print(f"DEBUG: Loading boundaries from {boundary_path}...")
    try:
        mada_borders = gpd.read_file(boundary_path)
        if mada_borders.crs != "EPSG:4326":
            mada_borders = mada_borders.to_crs("EPSG:4326")
        
        # Reproject to metric system (UTM Zone 39S / EPSG:32739) for accurate meter measurements
        mada_borders_metric = mada_borders.to_crs(epsg=32739)
        
        print("DEBUG: Generating coastline buffers (50m, 100m, 1km)...")
        
        # 50m buffer
        buf_50_df = mada_borders_metric.copy()
        buf_50_df.geometry = buf_50_df.geometry.boundary.buffer(50)
        buf_50_wgs84 = buf_50_df.dissolve().to_crs(epsg=4326).geometry.iloc[0]

        # 100m buffer
        buf_100_df = mada_borders_metric.copy()
        buf_100_df.geometry = buf_100_df.geometry.boundary.buffer(100)
        buf_100_wgs84 = buf_100_df.dissolve().to_crs(epsg=4326).geometry.iloc[0]

        # 1km (1000m) buffer
        buf_1km_df = mada_borders_metric.copy()
        buf_1km_df.geometry = buf_1km_df.geometry.boundary.buffer(1000)
        buf_1km_wgs84 = buf_1km_df.dissolve().to_crs(epsg=4326).geometry.iloc[0]
        
    except Exception as e:
        print(f"DEBUG ERROR: Failed to load or process boundary file '{boundary_path}': {e}")
        return
        
    # 4. Process GeoJSON files
    geojson_files = list(folder.glob("*.geojson"))
    print(f"DEBUG: Found {len(geojson_files)} '*.geojson' files in the folder.")
    
    for file_path in geojson_files:
        print(f"DEBUG: Reading file -> {file_path.name}")
        file_base_name = file_path.stem 
        mapped_source_image = tile_to_source.get(file_base_name, file_base_name)
        
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        features = data.get("features", [])
        print(f"DEBUG:     -> Found {len(features)} features inside {file_path.name}")
            
        for feature in features:
            ring = feature["geometry"]["coordinates"][0]
            
            # Calculate the centroid
            unique_points = ring[:-1]
            center_x = sum(p[0] for p in unique_points) / len(unique_points)
            center_y = sum(p[1] for p in unique_points) / len(unique_points)
            
            props = feature["properties"]
            
            # Create a Shapely Point for spatial evaluation (WGS84 lon/lat)
            point_geom = Point(center_x, center_y)
            
            # Evaluate proximity flags based on distance buffers
            is_veryclose = point_geom.intersects(buf_50_wgs84)
            is_close = point_geom.intersects(buf_100_wgs84)
            is_fareaway = point_geom.intersects(buf_1km_wgs84)
            
            consolidated_data.append({
                "coords": {
                    "x": center_x,
                    "y": center_y
                },
                "class_id": props.get("class_id"),
                "confidence": props.get("confidence"),
                "original_image": mapped_source_image,
                "veryclose": bool(is_veryclose),
                "close": bool(is_close),
                "fareaway": bool(is_fareaway)
            })

    # Export to a single JSON file
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(consolidated_data, f, indent=4)
        
    print(f"Successfully processed and saved {len(consolidated_data)} objects with proximity attributes to {output_file}.")

if __name__ == "__main__":
    process_geojson_objects(GEOJSON_FOLDER, OUTPUT_JSON, CSV_MAPPING_FILE, BOUNDARY_PATH)