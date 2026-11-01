import { describe, expect, it } from "vitest";
import { hexToHsv, hexToRgb, hsvToHex, INK_PALETTE, normalizeHex, rememberColor, saturationValueAt } from "../src/color";

describe("color conversion", () => {
  it.each([
    ["#FF0000", 0, 1, 1], ["#00FF00", 120, 1, 1], ["#0000FF", 240, 1, 1],
    ["#FFFF00", 60, 1, 1], ["#00FFFF", 180, 1, 1], ["#FF00FF", 300, 1, 1],
    ["#000000", 0, 0, 0], ["#FFFFFF", 0, 0, 1], ["#808080", 0, 0, 128 / 255],
  ])("converts %s into HSV components", (hex, h, s, v) => {
    const actual = hexToHsv(String(hex));
    expect(actual.h).toBeCloseTo(Number(h));
    expect(actual.s).toBeCloseTo(Number(s));
    expect(actual.v).toBeCloseTo(Number(v));
  });

  it("round-trips palette colors and mixed channels without substituting RGB for HSV", () => {
    const colors = [...INK_PALETTE.map(([hex]) => hex), "#010203", "#FEFD01", "#A71E64", "#135790", "#7F80FF"];
    for (const hex of colors) expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    for (const r of [0, 1, 47, 128, 254, 255]) for (const g of [0, 29, 128, 255]) for (const b of [0, 1, 129, 255]) {
      const hex = `#${[r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("normalizes editable HEX and rejects invalid values", () => {
    expect(normalizeHex(" abc ")).toBe("#AABBCC");
    expect(normalizeHex("#f47c66")).toBe("#F47C66");
    for (const invalid of ["", "#1234", "#GG0000", "#12345678", "rgb(0,0,0)"]) expect(normalizeHex(invalid)).toBeNull();
    expect(() => hexToRgb("oops")).toThrow();
  });

  it("wraps hue and clamps saturation and brightness", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#FF0000");
    expect(hsvToHex({ h: -120, s: 2, v: 2 })).toBe("#0000FF");
    expect(hsvToHex({ h: 80, s: 1, v: -1 })).toBe("#000000");
  });
});

describe("saturation/value pointer coordinates", () => {
  const rect = { left: 40, top: 90, width: 200, height: 100 };
  it.each([
    [40, 90, "#FFFFFF"], [240, 90, "#FF0000"], [40, 190, "#000000"], [240, 190, "#000000"],
    [140, 140, "#804040"], [90, 115, "#BF8F8F"], [190, 165, "#401010"],
  ])("maps (%s, %s) across both axes", (x, y, hex) => {
    expect(hsvToHex({ h: 0, ...saturationValueAt(Number(x), Number(y), rect) })).toBe(hex);
  });

  it("clamps a captured drag outside the selection and stays finite for a collapsed box", () => {
    expect(saturationValueAt(-20, 300, rect)).toEqual({ s: 0, v: 0 });
    expect(saturationValueAt(500, -30, rect)).toEqual({ s: 1, v: 1 });
    expect(saturationValueAt(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ s: 0, v: 1 });
  });

  it("keeps five distinct recent colors in use order", () => {
    let colors: string[] = [];
    for (const [hex] of INK_PALETTE) colors = rememberColor(colors, hex);
    expect(colors).toEqual(INK_PALETTE.slice(1).map(([hex]) => hex).reverse());
    expect(rememberColor(colors, "#ff8e7a")).toEqual(["#FF8E7A", ...colors.slice(0, 4)]);
  });
});
