// Draws the app icon (1024px PNG): a small pixel-art hero (our own character: masked, caped, fist up)
// on a night-sky rounded square. Usage: swift native/icon.swift out.png
import AppKit
let size = 1024.0
func rgb(_ hex: Int, _ a: Double = 1) -> NSColor {
  NSColor(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, alpha: a)
}
// One character per pixel. O body, S body shade, M mask, W eyes, C cape, B cape shade, Y chest spark, * star.
let art = [
  "..*.............",
  "............OO..",
  ".......*....OO..",
  "....OOOOOOOOOO..",
  "....OOOOOOOOOS..",
  "....MMMMMMMM....",
  "....MWWMMWWM....",
  "..CCMMMMMMMM..*.",
  ".CCCOOOOOOOO....",
  "CCCCOOOYYOOO....",
  "CCCCOOOYYOOO....",
  "CCCCOOOOOOOS....",
  "BCCCSSSSSSSS....",
  "BBCC.OO..OO.....",
  ".BBC.OO..OO...*.",
  "..B.............",
]
let colors: [Character: NSColor] = [
  "O": rgb(0xE08A5F), "S": rgb(0xB9643F), "M": rgb(0x1B2140), "W": rgb(0xFFFFFF),
  "C": rgb(0xE5484D), "B": rgb(0xA92F3A), "Y": rgb(0xFFE08A), "*": rgb(0xFFFFFF, 0.75),
]
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let inset = size * 0.09, rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let tile = NSBezierPath(roundedRect: rect, xRadius: size * 0.2, yRadius: size * 0.2)
NSGradient(colors: [rgb(0x3A4A9A), rgb(0x1A1F44)])!.draw(in: tile, angle: -90)
tile.addClip()
// A warm glow behind the hero.
NSGradient(colors: [rgb(0xFF9D5C, 0.42), rgb(0xFF9D5C, 0.12), rgb(0xFF9D5C, 0)])!
  .draw(fromCenter: NSPoint(x: size * 0.5, y: size * 0.46), radius: 0, toCenter: NSPoint(x: size * 0.5, y: size * 0.46), radius: size * 0.44, options: [])
let n = Double(art.count)
let cell = (rect.width * 0.84 / n).rounded()
let ox = ((size - cell * n) / 2 + cell * 0.9).rounded(), oy = ((size - cell * n) / 2).rounded() // nudged right: the cape is light, the fist heavy
NSGraphicsContext.current?.shouldAntialias = false
for (r, line) in art.enumerated() {
  for (c, ch) in line.enumerated() {
    guard let color = colors[ch] else { continue }
    color.setFill()
    let star = ch == "*"
    let s = star ? cell * 0.5 : cell + 1 // +1: no hairlines between neighbours
    NSRect(x: ox + Double(c) * cell + (star ? cell * 0.25 : 0), y: oy + (n - 1 - Double(r)) * cell + (star ? cell * 0.25 : 0), width: s, height: s).fill()
  }
}
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
