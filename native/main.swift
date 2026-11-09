// Claude Code Super UI: native macOS host for claude-pane.
// Starts the Node server (build/server.js) as a child process, then shows each
// window's UI in a WKWebView. Menus: ⌘N window, ⌘T tab, ⌘W close tab, ⇧⌘]/[ cycle tabs.
// The dev-build paths below are filled in by scripts/build-app.sh.
import Cocoa
import UserNotifications
import WebKit

// Distribution build: Node and the server ship inside the bundle (Contents/Resources/node, .../app).
// Dev build: absolute paths baked in by scripts/build-app.sh, so edits to public/ show up on ⌘R.
let bundledServer = Bundle.main.resourceURL!.appendingPathComponent("app/build/server.js").path
let isBundled = FileManager.default.fileExists(atPath: bundledServer)
let nodePath = isBundled ? Bundle.main.resourceURL!.appendingPathComponent("node").path : "NODE_PATH_PLACEHOLDER"
let serverPath = isBundled ? bundledServer : "SERVER_PATH_PLACEHOLDER"
let logURL = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Logs/claude-super-ui.log")

// MARK: - Server child process

final class Server {
  private let proc = Process()
  private var baseURL: URL?
  private var waiting: [(URL) -> Void] = []
  private var buffer = ""
  var stopping = false

  func start() {
    proc.executableURL = URL(fileURLWithPath: nodePath)
    proc.arguments = [serverPath]
    proc.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    var env = ProcessInfo.processInfo.environment
    env["CLAUDE_PANE_APP"] = "1"
    env["CLAUDE_PANE_T0"] = String(Date().timeIntervalSince1970)
    if env["SHELL"] == nil { env["SHELL"] = "/bin/zsh" }
    proc.environment = env

    // Private (it holds the page URL with its access token) and rotated at 5 MB.
    let fm = FileManager.default
    if let size = (try? fm.attributesOfItem(atPath: logURL.path))?[.size] as? Int, size > 5_000_000 {
      let old = logURL.appendingPathExtension("1")
      try? fm.removeItem(at: old)
      try? fm.moveItem(at: logURL, to: old)
    }
    if !fm.fileExists(atPath: logURL.path) {
      fm.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
    let log = try? FileHandle(forWritingTo: logURL)
    log?.seekToEndOfFile()
    log?.write("--- \(Date()) app launch\n".data(using: .utf8)!)

    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let data = h.availableData
      guard !data.isEmpty else { return }
      log?.write(data)
      guard let text = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async { self?.scan(text) }
    }
    proc.terminationHandler = { [weak self] p in
      DispatchQueue.main.async {
        guard let self, !self.stopping else { return }
        let a = NSAlert()
        a.messageText = "The Claude Code Super UI server stopped (exit \(p.terminationStatus))."
        a.informativeText = "Details are in ~/Library/Logs/claude-super-ui.log"
        a.runModal()
        NSApp.terminate(nil)
      }
    }
    do { try proc.run() } catch {
      let a = NSAlert()
      a.messageText = "Couldn't start the server: \(error.localizedDescription)"
      a.informativeText = "node: \(nodePath)\nserver: \(serverPath)"
      a.runModal()
      NSApp.terminate(nil)
    }
  }

  private func scan(_ text: String) {
    guard baseURL == nil else { return }
    buffer += text
    guard let r = buffer.range(of: #"http://127\.0\.0\.1:\d+/\?t=[0-9a-f]+"#, options: .regularExpression),
          let url = URL(string: String(buffer[r])) else { return }
    baseURL = url
    waiting.forEach { $0(url) }
    waiting = []
  }

  var url: URL? { baseURL }

  func whenReady(_ f: @escaping (URL) -> Void) {
    if let u = baseURL { f(u) } else { waiting.append(f) }
  }

  func stop() {
    stopping = true
    if proc.isRunning { proc.terminate(); proc.waitUntilExit() }
  }
}

// MARK: - One window

/// WKUserContentController retains its handlers; this breaks the cycle.
final class WeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ t: WKScriptMessageHandler) { target = t }
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    target?.userContentController(c, didReceive: m)
  }
}

/// Drops of files/folders type their shell-escaped paths into the active tab, like Terminal.
/// (Pages never see file paths, so the native view handles the drop itself.)
final class DropWebView: WKWebView {
  var onDropPaths: (([String]) -> Void)?

  private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
    let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
    return info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts) as? [URL] ?? []
  }

  override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
    fileURLs(info).isEmpty ? super.draggingEntered(info) : .copy
  }
  override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation {
    fileURLs(info).isEmpty ? super.draggingUpdated(info) : .copy
  }
  override func prepareForDragOperation(_ info: NSDraggingInfo) -> Bool {
    fileURLs(info).isEmpty ? super.prepareForDragOperation(info) : true
  }
  override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    let urls = fileURLs(info)
    guard !urls.isEmpty else { return super.performDragOperation(info) }
    onDropPaths?(urls.map(\.path))
    return true
  }
}

/// Terminal.app-style escaping: backslash before anything the shell would treat specially.
func shellEscape(_ path: String) -> String {
  let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.,:/@+=%^~")
  return path.unicodeScalars.map { safe.contains($0) ? String($0) : "\\" + String($0) }.joined()
}

final class PaneWindow: NSObject, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
  let id: String
  let window: NSWindow
  let web: WKWebView
  var waitingCount = 0
  private var titleObs: NSKeyValueObservation?
  private weak var app: AppDelegate?

  /// `detached`: opened to receive a tab dragged out of another window (no starter shell tab).
  init(url: URL, app: AppDelegate, id: String = UUID().uuidString, detached: Bool = false) {
    self.app = app
    self.id = id
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    let dropView = DropWebView(frame: .zero, configuration: cfg)
    web = dropView
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    super.init()
    cfg.userContentController.add(WeakHandler(self), name: "native")
    dropView.onDropPaths = { [weak self] paths in
      guard let self else { return }
      let text = paths.map(shellEscape).joined(separator: " ") + " "
      let json = String(data: try! JSONSerialization.data(withJSONObject: [text]), encoding: .utf8)!
      self.window.makeKeyAndOrderFront(nil)
      self.js("window.cp?.paste(\(json)[0])")
    }
    web.uiDelegate = self
    web.navigationDelegate = self
    window.contentView = web
    window.delegate = self
    window.title = "Claude Code Super UI"
    window.tabbingMode = .disallowed // our tabs live in the page
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 520, height: 360)
    titleObs = web.observe(\.title) { [weak self] w, _ in
      if let t = w.title, !t.isEmpty { self?.window.title = t }
    }
    var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "w", value: id)]
      + (detached ? [URLQueryItem(name: "detached", value: "1")] : [])
    web.load(URLRequest(url: c.url!))
  }

  /// The page's process crashed (or was killed for memory): reload it. The server keeps the tabs alive.
  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

  func js(_ code: String, _ done: ((Any?) -> Void)? = nil) {
    web.evaluateJavaScript(code) { result, _ in done?(result) }
  }

  // Page -> app messages: notifications and the waiting-tab count.
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let d = m.body as? [String: Any], let type = d["type"] as? String else { return }
    switch type {
    case "notify":
      app?.notify(title: d["title"] as? String ?? "", body: d["body"] as? String ?? "",
                  window: id, tab: "\(d["tab"] ?? "")")
    case "badge":
      waitingCount = d["count"] as? Int ?? 0
      app?.updateBadge()
    case "tab-dropped":
      app?.tabDropped(from: self, tab: "\(d["tab"] ?? "")", only: d["only"] as? Bool ?? false)
    case "close-window":
      window.close()
    default: break
    }
  }

  // JS confirm()/alert() need native sheets in WKWebView.
  func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = field
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  // Links (target=_blank or anything off our server) open in the default browser.
  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let u = action.request.url { NSWorkspace.shared.open(u) }
    return nil
  }

  func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let u = action.request.url, u.host != "127.0.0.1", u.scheme != "about" {
      NSWorkspace.shared.open(u)
      decisionHandler(.cancel)
    } else {
      decisionHandler(.allow)
    }
  }

  /// Closing a window ends its tabs: ask first if Claude is mid-task in any of them.
  private var closeConfirmed = false
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if closeConfirmed { return true }
    guard let app else { return true }
    app.busyTabs(window: id) { [weak self] busy in
      guard let self else { return }
      if busy.isEmpty { self.closeConfirmed = true; self.window.performClose(nil); return }
      let a = busyAlert(busy, action: "Close Window")
      a.beginSheetModal(for: self.window) { r in
        if r == .alertFirstButtonReturn { self.closeConfirmed = true; self.window.performClose(nil) }
      }
    }
    return false
  }

  func windowWillClose(_ n: Notification) { app?.closed(self) }
}

/// "Claude is still working in 2 tabs" with the tabs listed; first button confirms.
func busyAlert(_ busy: [String], action: String) -> NSAlert {
  let a = NSAlert()
  a.alertStyle = .warning
  a.messageText = busy.count == 1 ? "Claude is still working in 1 tab" : "Claude is still working in \(busy.count) tabs"
  a.informativeText = busy.prefix(8).map { "• \($0)" }.joined(separator: "\n")
    + (busy.count > 8 ? "\n…and \(busy.count - 8) more" : "")
    + "\n\nIf you \(action == "Quit" ? "quit" : "close it") now, those tasks stop where they are."
  a.addButton(withTitle: action == "Quit" ? "Quit Anyway" : "Close Anyway")
  a.addButton(withTitle: "Cancel")
  a.buttons[1].keyEquivalent = "\u{1b}"
  return a
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  let server = Server()
  var panes: [PaneWindow] = []

  func applicationDidFinishLaunching(_ n: Notification) {
    // A tab drag released outside the window never reaches the page; tell it about every mouse-up.
    NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { [weak self] e in
      if let w = e.window ?? NSApp.keyWindow, let p = self?.panes.first(where: { $0.window === w }) {
        let outside = !w.frame.contains(NSEvent.mouseLocation)
        p.js("window.cp?.endDrag(\(outside))")
      }
      return e
    }
    buildMenu()
    server.start()
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      // Wake from sleep: repaint every window's terminal once things settle.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self?.panes.forEach { $0.js("window.cp?.redraw()") } }
    }
    newWindow(nil)
  }

  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { newWindow(nil) }
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
  func applicationWillTerminate(_ n: Notification) { server.stop() }

  /// Quitting ends every tab: ask first if Claude is mid-task anywhere.
  private var quitConfirmed = false
  func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
    if quitConfirmed { return .terminateNow }
    busyTabs(window: nil) { busy in
      if busy.isEmpty { NSApp.reply(toApplicationShouldTerminate: true); return }
      NSApp.activate(ignoringOtherApps: true)
      let ok = busyAlert(busy, action: "Quit").runModal() == .alertFirstButtonReturn
      NSApp.reply(toApplicationShouldTerminate: ok)
    }
    return .terminateLater
  }

  /// Titles of tabs where Claude is mid-task (all windows, or one). Empty if the server can't say.
  func busyTabs(window: String?, done: @escaping ([String]) -> Void) {
    guard let base = server.url, var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { done([]); return }
    c.path = "/api/busy"
    if let window { c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "w", value: window)] }
    guard let url = c.url else { done([]); return }
    var req = URLRequest(url: url); req.timeoutInterval = 1.5
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let list = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["busy"] as? [String] ?? []
      DispatchQueue.main.async { done(list) }
    }.resume()
  }

  var keyPane: PaneWindow? { panes.first { $0.window.isKeyWindow } ?? panes.last }

  @objc func newWindow(_ sender: Any?) {
    server.whenReady { [weak self] url in
      guard let self else { return }
      let p = PaneWindow(url: url, app: self)
      if let last = self.panes.last?.window {
        p.window.setFrameTopLeftPoint(NSPoint(x: last.frame.minX + 28, y: last.frame.maxY - 28))
      } else {
        p.window.center()
      }
      self.panes.append(p)
      p.window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  /// A tab was dragged out of `src`'s tab bar and released. Over another of our windows: move it there.
  /// Anywhere else: give it a new window under the mouse (unless it was the window's only tab).
  func tabDropped(from src: PaneWindow, tab: String, only: Bool) {
    let pt = NSEvent.mouseLocation
    let q = { (s: String) in String(data: try! JSONSerialization.data(withJSONObject: [s]), encoding: .utf8)! + "[0]" }
    if !src.window.frame.contains(pt) {
      // Front-most of our windows under the mouse.
      let under = NSApp.orderedWindows.first { $0 !== src.window && $0.isVisible && $0.frame.contains(pt) }
      if let w = under, let target = panes.first(where: { $0.window === w }) {
        src.js("window.cp?.moveTab(\(q(tab)), \(q(target.id)))")
        target.window.makeKeyAndOrderFront(nil)
        return
      }
    }
    if only { return } // nothing to split off
    server.whenReady { [weak self] url in
      guard let self else { return }
      let p = PaneWindow(url: url, app: self, detached: true)
      p.window.setFrame(src.window.frame, display: false) // same size as the source window
      p.window.setFrameTopLeftPoint(NSPoint(x: pt.x - 90, y: pt.y + 16)) // tab bar under the cursor
      self.panes.append(p)
      src.js("window.cp?.moveTab(\(q(tab)), \(q(p.id)))")
      p.window.makeKeyAndOrderFront(nil)
    }
  }

  @objc func newTab(_ s: Any?) {
    // No window open: a "new tab" is a new window.
    if let p = keyPane { p.js("window.cp?.newTab()") } else { newWindow(s) }
  }
  @objc func closeTab(_ s: Any?) {
    guard let p = keyPane else { return }
    p.js("window.cp ? window.cp.closeTab() : false") { r in
      if (r as? Bool) != true { p.window.performClose(nil) }
    }
  }
  @objc func closeWindow(_ s: Any?) { keyPane?.window.performClose(nil) }
  @objc func nextTab(_ s: Any?) { keyPane?.js("window.cp?.nextTab()") }
  @objc func toggleSplit(_ s: Any?) { keyPane?.js("window.cp?.toggleSplit()") }
  @objc func prevTab(_ s: Any?) { keyPane?.js("window.cp?.prevTab()") }
  @objc func jumpToWaiting(_ s: Any?) { keyPane?.js("window.cp?.jumpToAttention()") }
  @objc func redraw(_ s: Any?) { keyPane?.js("window.cp?.redraw()") }
  @objc func reload(_ s: Any?) { keyPane?.web.reload() }
  @objc func saveWorkspace(_ s: Any?) { keyPane?.js("window.cp?.saveWorkspace()") }
  @objc func openWorkspace(_ s: Any?) { keyPane?.js("window.cp?.openWorkspaceMenu()") }

  func closed(_ p: PaneWindow) {
    panes.removeAll { $0 === p }
    updateBadge()
  }

  func updateBadge() {
    let total = panes.reduce(0) { $0 + $1.waitingCount }
    NSApp.dockTile.badgeLabel = total > 0 ? "\(total)" : nil
  }

  func notify(title: String, body: String, window: String, tab: String) {
    let c = UNMutableNotificationContent()
    c.title = title
    c.body = body
    c.sound = .default
    c.userInfo = ["window": window, "tab": tab]
    let req = UNNotificationRequest(identifier: "\(window)-\(tab)", content: c, trigger: nil)
    UNUserNotificationCenter.current().add(req)
  }

  // Show banners even while the app is frontmost (the page only asks when you're elsewhere).
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound])
  }

  // Clicking a notification: bring that window forward and switch to the tab.
  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    let info = r.notification.request.content.userInfo
    let w = info["window"] as? String, tab = info["tab"] as? String ?? ""
    DispatchQueue.main.async {
      if let p = self.panes.first(where: { $0.id == w }) {
        NSApp.activate(ignoringOtherApps: true)
        p.window.makeKeyAndOrderFront(nil)
        p.js("window.cp?.activate(\(String(reflecting: tab)))")
      }
      done()
    }
  }

  private func buildMenu() {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let top = NSMenuItem()
      let m = NSMenu(title: title)
      items.forEach { m.addItem($0) }
      top.submenu = m
      main.addItem(top)
      return m
    }
    func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
      i.keyEquivalentModifierMask = mods
      return i
    }
    let name = "Claude Code Super UI"
    _ = add(name, [
      item("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      item("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      item("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = add("File", [
      item("New Tab", #selector(newTab(_:)), "n"),
      { // ⌘T also opens a tab (hidden duplicate so the menu shows one shortcut)
        let i = item("New Tab", #selector(newTab(_:)), "t")
        i.isHidden = true
        i.allowsKeyEquivalentWhenHidden = true
        return i
      }(),
      item("New Window", #selector(newWindow(_:)), "n", [.command, .shift]),
      .separator(),
      item("Save Workspace…", #selector(saveWorkspace(_:)), "s", [.command, .option]),
      item("Open Workspace…", #selector(openWorkspace(_:)), "o", [.command, .option]),
      .separator(),
      item("Close Tab", #selector(closeTab(_:)), "w"),
      item("Close Window", #selector(closeWindow(_:)), "w", [.command, .shift]),
    ])
    _ = add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    _ = add("View", [
      item("Next Tab", #selector(nextTab(_:)), "]", [.command, .shift]),
      item("Previous Tab", #selector(prevTab(_:)), "[", [.command, .shift]),
      item("Jump to Waiting Tab", #selector(jumpToWaiting(_:)), "j"),
      .separator(),
      item("Split View", #selector(toggleSplit(_:)), "\\"),
      item("Redraw Terminal", #selector(redraw(_:)), "l", [.command, .shift]),
      item("Reload Window", #selector(reload(_:)), "r"),
    ])
    let win = add("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
    ])
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
