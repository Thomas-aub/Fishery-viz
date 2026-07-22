import json
from pathlib import Path
import rasterio
from rasterio.warp import transform_geom
from shapely.geometry import shape, box
import geopandas as gpd

# --- PARAMETERS ---
FOLDER_PATH = "/mnt/DATA/thomas/data_center/Madagascar/data/inference/enhanced/"  
OUTPUT_JSON = "/mnt/DATA/thomas/data_center/Madagascar/mapping/Images_metadata.json"
BOUNDARY_PATH = "/mnt/DATA/thomas/data_center/Madagascar/mada_boundaries.geojson"
# ------------------

def generate_tif_metadata(folder_path: str, output_file: str, boundary_path: str) -> None:
    """Extracts 4-corner coordinates, CRS, and precomputed intersected area in km² from all TIF files."""
    
    print(f"Loading boundaries from {boundary_path}...")
    boundaries_gpd = gpd.read_file(boundary_path)
    
    # Ensure boundaries are in WGS84 (EPSG:4326)
    if boundaries_gpd.crs != "EPSG:4326":
        boundaries_gpd = boundaries_gpd.to_crs("EPSG:4326")
    
    # Create a single unary union of all boundary polygons for efficient intersection
    land_union = boundaries_gpd.geometry.unary_union
    
    metadata = []
    folder = Path(folder_path)
    tif_files = [f for f in folder.iterdir() if f.suffix.lower() == ".tif"]
    
    print(f"Processing {len(tif_files)} TIF files...")
    for file_path in tif_files:
        try:
            with rasterio.open(file_path) as src:
                bounds = src.bounds
                src_crs = src.crs.to_string() if src.crs else "EPSG:32739"
                
                # Define the footprint box in native raster CRS
                geom_dict = {
                    "type": "Polygon", 
                    "coordinates": [[
                        (bounds.left, bounds.top),
                        (bounds.right, bounds.top),
                        (bounds.right, bounds.bottom),
                        (bounds.left, bounds.bottom),
                        (bounds.left, bounds.top)
                    ]]
                }
                
                # Transform footprint to WGS84 (EPSG:4326) to match boundaries
                transformed_geom = transform_geom(src_crs, "EPSG:4326", geom_dict)
                wgs84_polygon = shape(transformed_geom)
                
                # Compute spatial intersection with Madagascar boundaries
                intersected_geom = wgs84_polygon.intersection(land_union)
                
                # Calculate area in km² using local UTM zone 39S (EPSG:32739) for Madagascar meters
                area_km2 = 0.0
                if not intersected_geom.is_empty:
                    gs = gpd.GeoSeries([intersected_geom], crs="EPSG:4326")
                    gs_utm = gs.to_crs("EPSG:32739")
                    area_m2 = gs_utm.geometry.area.sum()
                    area_km2 = float(area_m2 / 1e6)
                
                metadata.append({
                    "filename": file_path.name,
                    "crs": src_crs,
                    "area": round(area_km2, 4),
                    "coordinates": {
                        "top_left": (bounds.left, bounds.top),
                        "top_right": (bounds.right, bounds.top),
                        "bottom_right": (bounds.right, bounds.bottom),
                        "bottom_left": (bounds.left, bounds.bottom)
                    }
                })
        except rasterio.errors.RasterioIOError:
            print(f"Warning: Could not read {file_path.name}. It may be corrupted.")
        except Exception as e:
            print(f"Error processing {file_path.name}: {e}")

    # Save to JSON
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=4)
        
    print(f"Successfully saved metadata and precomputed areas for {len(metadata)} images to {output_file}.")

if __name__ == "__main__":
    generate_tif_metadata(FOLDER_PATH, OUTPUT_JSON, BOUNDARY_PATH)