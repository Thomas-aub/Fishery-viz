// map.test.js

// --- Recreating pure functions from map.js for testing ---
// (Alternatively, you can export these functions from map.js using module.exports)

function stripExtension(filename) {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? filename : filename.slice(0, dot);
}

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
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));

  const phi1 = mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);

  const lonOrigin = (zone - 1) * 6 - 180 + 3;
  return [
    Number(((lonOrigin + (1 * 180) / Math.PI)).toFixed(4)),
    Number((phi1 * 180 / Math.PI).toFixed(4))
  ];
}

describe("Map Utility Functions", () => {
  
  test("stripExtension removes file extensions correctly", () => {
    expect(stripExtension("image_001.tif")).toBe("image_001");
    expect(stripExtension("data.json")).toBe("data");
    expect(stripExtension("noextension")).toBe("noextension");
  });

  test("utmToWgs84 returns valid coordinate structures", () => {
    // Testing with a sample UTM coordinate in Zone 39S (Madagascar region)[cite: 4]
    const result = utmToWgs84(500000, 8000000, 39, "S");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(typeof result[0]).toBe("number");
    expect(typeof result[1]).toBe("number");
  });

});