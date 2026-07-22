import os
import glob
import subprocess
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

PANSHARPENED_DIR = "/mnt/DATA/thomas/data_center/Madagascar/pansharpened"
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
        return jsonify({"error": f"TIF file matching '{base_name}' not found in pansharpened folder."}), 404

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

    # --- 3. Corrected PyQGIS Auto-Styling Script ---
    script_path = os.path.join("/tmp", "qgis_auto_style.py")
    pyqgis_code = f"""
from qgis.core import QgsProject, QgsRasterLayer, QgsVectorLayer, QgsCategorizedSymbolRenderer, QgsRendererCategory, QgsSymbol, QgsContrastEnhancement, QgsRasterRange

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
        
        # Set additional NoData value = 0 (wrapped in a list)
        provider = layer.dataProvider()
        if provider:
            for b in range(1, layer.bandCount() + 1):
                provider.setUserNoDataValue(b, [QgsRasterRange(0, 0)])
        layer.triggerRepaint()
        
    elif layer.type() == QgsVectorLayer.VectorLayer and 'geojson' in layer.source().lower():
        # Apply Categorized renderer using 'class_id' field
        if layer.fields().indexOf('class_id') != -1:
            categories = []
            unique_values = layer.uniqueValues(layer.fields().indexOf('class_id'))
            for val in unique_values:
                symbol = QgsSymbol.defaultSymbol(layer.geometryType())
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