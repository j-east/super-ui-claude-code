// Draws the app icon (1024px PNG): a warm rounded square with a white asterisk mark.
// Usage: swift native/icon.swift out.png
import AppKit
let size = 1024.0
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let inset = size * 0.09, rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let path = NSBezierPath(roundedRect: rect, xRadius: size * 0.2, yRadius: size * 0.2)
NSGradient(colors: [NSColor(red: 0.89, green: 0.50, blue: 0.37, alpha: 1), NSColor(red: 0.74, green: 0.36, blue: 0.25, alpha: 1)])!
  .draw(in: path, angle: -90)
let mark = "✳" as NSString
let font = NSFont.systemFont(ofSize: size * 0.56, weight: .bold)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
let m = mark.size(withAttributes: attrs)
mark.draw(at: NSPoint(x: (size - m.width) / 2, y: (size - m.height) / 2), withAttributes: attrs)
img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
