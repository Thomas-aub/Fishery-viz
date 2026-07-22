import os
import glob
import subprocess
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PANSHARPENED_DIR = "/mnt/DATA/thomas/data_center/Madagascar/data/inference/enhanced"
GEOJSON_DIR = "/mnt/DATA/thomas/data_center/Madagascar/data/inference/geojson"

@app.route('/open-qgis', methods=['POST'])
def open_qgis():
    data = request.json
    filename = data.get('filename')
    
    if not filename:
        return jsonify({"error": "No filename provided"}), 400

    base_name = os.path.splitext(filename)[0]

    # --- 1. Flexible TIF Search ---
    matching_tifs = []
    for root, dirs, files in os.walk(PANSHARPENED_DIR):
        for f in files:
            if base_name.lower() in f.lower() and f.lower().endswith(('.tif', '.tiff')):
                matching_tifs.append(os.path.join(root, f))

    if not matching_tifs:
        return jsonify({"error": f"TIF file matching '{base_name}' not found in enhanced folder."}), 404

    tif_path = matching_tifs[0]

    # --- 2. Flexible GeoJSON Search ---
    matching_geojson = []
    for root, dirs, files in os.walk(GEOJSON_DIR):
        for f in files:
            if base_name.lower() in f.lower() and f.lower().endswith('.geojson'):
                matching_geojson.append(os.path.join(root, f))

    if not matching_geojson:
        return jsonify({"error": f"GeoJSON file matching '{base_name}' not found in geojson folder."}), 404

    geojson_path = matching_geojson[0]

    # --- 3. PyQGIS Auto-Styling Script with Distinct Class Outlines ---
    script_path = os.path.join("/tmp", "qgis_auto_style.py")
    
    # Using a normal string instead of an f-string to avoid formatting conflicts
    pyqgis_code = """
from qgis.core import (
    QgsProject, QgsRasterLayer, QgsVectorLayer, 
    QgsCategorizedSymbolRenderer, QgsRendererCategory, 
    QgsSymbol, QgsContrastEnhancement, QgsRasterRange
)
from qgis.PyQt.QtGui import QColor

# Distinct color palette for different class_ids
palette = [
    QColor(37, 99, 235),   # Blue (#2563eb)
    QColor(217, 119, 6),   # Orange (#d97706)
    QColor(5, 150, 105),   # Green (#059669)
    QColor(224, 32, 30),   # Red (#e0201e)
    QColor(147, 51, 234),  # Purple
    QColor(219, 39, 119)   # Pink
]

layers = QgsProject.instance().mapLayers().values()
for layer in layers:
    if layer.type() == QgsRasterLayer.RasterLayer:
        renderer = layer.renderer()
        if renderer and hasattr(renderer, 'redBand'):
            # Apply Min/Max contrast stretch across RGB bands
            for band in [renderer.redBand(), renderer.greenBand(), renderer.blueBand()]:
                if band > 0:
                    ce = QgsContrastEnhancement(renderer.dataType(band))
                    ce.setContrastEnhancementAlgorithm(QgsContrastEnhancement.StretchToMinimumMaximum)
                    if band == renderer.redBand():
                        renderer.setRedContrastEnhancement(ce)
                    elif band == renderer.greenBand():
                        renderer.setGreenContrastEnhancement(ce)
                    elif band == renderer.blueBand():
                        renderer.setBlueContrastEnhancement(ce)
        
        # Set additional NoData value = 0
        provider = layer.dataProvider()
        if provider:
            for b in range(1, layer.bandCount() + 1):
                provider.setUserNoDataValue(b, [QgsRasterRange(0, 0)])
        layer.triggerRepaint()
        
    elif layer.type() == QgsVectorLayer.VectorLayer and 'geojson' in layer.source().lower():
        # Apply Categorized renderer using 'class_id' field with Unique Outline styling
        if layer.fields().indexOf('class_id') != -1:
            categories = []
            unique_values = layer.uniqueValues(layer.fields().indexOf('class_id'))
            
            for i, val in enumerate(unique_values):
                symbol = QgsSymbol.defaultSymbol(layer.geometryType())
                
                if symbol.symbolLayerCount() > 0:
                    symbolLayer = symbol.symbolLayer(0)
                    # Transparent fill (Alpha = 0)
                    if hasattr(symbolLayer, 'setFillColor'):
                        symbolLayer.setFillColor(QColor(0, 0, 0, 0))
                    
                    # Assign a distinct border color per class_id from the palette
                    if hasattr(symbolLayer, 'setStrokeColor'):
                        stroke_color = palette[i % len(palette)]
                        symbolLayer.setStrokeColor(stroke_color)
                    
                    # Optional: Adjust outline stroke width for visibility
                    if hasattr(symbolLayer, 'setStrokeWidth'):
                        symbolLayer.setStrokeWidth(0.8)
                
                category = QgsRendererCategory(val, symbol, str(val))
                categories.append(category)
            
            renderer = QgsCategorizedSymbolRenderer('class_id', categories)
            if renderer:
                layer.setRenderer(renderer)
            layer.triggerRepaint()
"""

    with open(script_path, "w") as f:
        f.write(pyqgis_code)

    try:
        # Clean environment to avoid Conda conflicts
        clean_env = os.environ.copy()
        for key in ["PYTHONPATH", "PYTHONHOME", "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "CONDA_SHLVL"]:
            clean_env.pop(key, None)
        
        path_dirs = clean_env.get("PATH", "").split(os.pathsep)
        path_dirs = [d for d in path_dirs if "miniconda3" not in d and "anaconda3" not in d]
        clean_env["PATH"] = os.pathsep.join(path_dirs)

        # Launch QGIS with layers and auto-styling code
        subprocess.Popen(["qgis", tif_path, geojson_path, "--code", script_path], env=clean_env)
        
        return jsonify({"success": True, "opened": [tif_path, geojson_path]}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000)