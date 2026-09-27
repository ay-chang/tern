// Draws the Tern app icon (the green "›_" tile from the UI) as a 1024×1024 PNG.
//
//   swift scripts/make-icon.swift src-tauri/icons/app-icon.png
//   npx tauri icon src-tauri/icons/app-icon.png
//
// The glyph is drawn as shapes rather than set in Geist Mono so the result
// doesn't depend on installed fonts.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "app-icon.png"

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(
        srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
        green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: alpha
    )
}

let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
// Work top-down like the design does.
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)

// macOS icon grid: an 824pt tile centered on the 1024 canvas, leaving room for the shadow.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let radius: CGFloat = 186
let tilePath = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)

ctx.saveGState()
// Shadow offsets ignore the flipped CTM, so negative height means "down".
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 24, color: rgb(0x000000, 0.28))
ctx.addPath(tilePath)
ctx.setFillColor(rgb(0x68d7a1))
ctx.fillPath()
ctx.restoreGState()

// A faint top-to-bottom sheen so the flat --g green reads well in the Dock.
ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()
let sheen = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
    colors: [rgb(0xffffff, 0.14), rgb(0xffffff, 0.0), rgb(0x000000, 0.06)] as CFArray,
    locations: [0, 0.55, 1]
)!
ctx.drawLinearGradient(sheen, start: CGPoint(x: 0, y: tile.minY), end: CGPoint(x: 0, y: tile.maxY), options: [])
ctx.restoreGState()

// "›_" in --term, proportioned like Geist Mono semibold at the logo's size.
let ink = rgb(0x131416)
let stroke: CGFloat = 36
let ox = tile.minX
let oy = tile.minY

ctx.setStrokeColor(ink)
ctx.setLineWidth(stroke)
ctx.setLineJoin(.miter)
ctx.setLineCap(.butt)
ctx.move(to: CGPoint(x: ox + 268, y: oy + 318))
ctx.addLine(to: CGPoint(x: ox + 378, y: oy + 412))
ctx.addLine(to: CGPoint(x: ox + 268, y: oy + 506))
ctx.strokePath()

let bar = CGRect(x: ox + 416, y: oy + 496, width: 160, height: stroke)
ctx.addPath(CGPath(roundedRect: bar, cornerWidth: 6, cornerHeight: 6, transform: nil))
ctx.setFillColor(ink)
ctx.fillPath()

let image = ctx.makeImage()!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out)")
