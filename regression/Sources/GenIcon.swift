// 图标生成器:用 CoreGraphics 直接画,不依赖 rsvg/ImageMagick。
// 用法:swift GenIcon.swift <输出目录>   → 产出 iconset 所需的全部 PNG。
//
// 图形语义:深色圆角底(与 AgOS 暗色 ground 同族)+ 中心蓝核(deepseek-400)
// + 三颗环绕的白色卫星(舰队:主控 + 子代理),外圈是它们的轨道。

import AppKit
import CoreGraphics
import Foundation

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."

func drawIcon(size: Int) -> Data? {
    let s = CGFloat(size)
    guard let ctx = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    // 底:圆角方,macOS 图标习惯的 22% 圆角
    let inset = s * 0.06
    let rect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = rect.width * 0.235
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.addPath(path)
    ctx.setFillColor(CGColor(red: 0.078, green: 0.078, blue: 0.086, alpha: 1)) // #141416
    ctx.fillPath()

    let cx = s / 2, cy = s / 2
    let accent = CGColor(red: 0.404, green: 0.620, blue: 0.996, alpha: 1) // #679efe
    let paper = CGColor(red: 0.961, green: 0.961, blue: 0.969, alpha: 1)   // #f5f5f7

    // 轨道
    ctx.setStrokeColor(accent.copy(alpha: 0.32)!)
    ctx.setLineWidth(max(1, s * 0.013))
    ctx.addArc(center: CGPoint(x: cx, y: cy), radius: s * 0.322, startAngle: 0, endAngle: .pi * 2, clockwise: false)
    ctx.strokePath()

    // 中心核
    ctx.setFillColor(accent)
    ctx.addArc(center: CGPoint(x: cx, y: cy), radius: s * 0.125, startAngle: 0, endAngle: .pi * 2, clockwise: false)
    ctx.fillPath()

    // 三颗卫星:120° 等分
    ctx.setFillColor(paper)
    for i in 0..<3 {
        let angle = CGFloat.pi / 2 + CGFloat(i) * (.pi * 2 / 3)
        let px = cx + cos(angle) * s * 0.322
        let py = cy + sin(angle) * s * 0.322
        ctx.addArc(center: CGPoint(x: px, y: py), radius: s * 0.045, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.fillPath()
    }

    guard let cgImage = ctx.makeImage() else { return nil }
    let rep = NSBitmapImageRep(cgImage: cgImage)
    return rep.representation(using: .png, properties: [:])
}

let sizes = [16, 32, 64, 128, 256, 512, 1024]
for size in sizes {
    guard let data = drawIcon(size: size) else { continue }
    let path = "\(outDir)/icon_\(size)x\(size).png"
    try? data.write(to: URL(fileURLWithPath: path))
}
// Retina 变体:iconutil 要求成对出现
let retina: [(Int, Int)] = [(16, 32), (32, 64), (128, 256), (256, 512), (512, 1024)]
for (logical, pixel) in retina {
    guard let data = drawIcon(size: pixel) else { continue }
    try? data.write(to: URL(fileURLWithPath: "\(outDir)/icon_\(logical)x\(logical)@2x.png"))
}
print("icons written to \(outDir)")
