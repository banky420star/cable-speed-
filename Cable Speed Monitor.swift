import Cocoa
import WebKit

/// PID of the server this app instance started (or -1 if it reused one).
/// Set off the main thread; read on the main thread when quitting.
var startedServerPID: pid_t = -1

// ---------------------------------------------------------------------------
// Cable Speed Monitor — native macOS app.
// Opens the dashboard in its own WebKit window (no browser). Ensures the API
// server on :8787 is running first — preferring the runtime embedded in this
// bundle (Contents/Resources/runtime), so the app is transportable: copy the
// .app anywhere and it works, as long as Node.js is installed.
// ---------------------------------------------------------------------------

/// Server check + startup. Runs off the main thread (no UI state).
func ensureServerRunning() -> Bool {
    if serverResponds() { return true }

    let projectDir = findProjectDirectory()
    guard let projectDir = projectDir else { return false }

    let nodeBin = findNodeBinary()
    guard let nodeBin = nodeBin else { return false }

    let proc = Process()
    proc.executableURL = nodeBin
    proc.arguments = [projectDir.appendingPathComponent("server.cjs").path]
    proc.currentDirectoryURL = projectDir
    let logPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/cable-speed-monitor.log").path
    if let fh = FileHandle(forWritingAtPath: logPath) {
        proc.standardOutput = fh
        proc.standardError = fh
    }
    do {
        try proc.run()
    } catch {
        return false
    }
    startedServerPID = proc.processIdentifier

    // Wait (max ~15s) for the server to answer.
    for _ in 0..<30 {
        if serverResponds() { return true }
        Thread.sleep(forTimeInterval: 0.5)
    }
    return false
}

private func serverResponds() -> Bool {
    let url = URL(string: "http://localhost:8787/api/status")!
    var request = URLRequest(url: url)
    request.timeoutInterval = 2
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: request) { _, response, _ in
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
            ok = true
        }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 3)
    return ok
}

private func findProjectDirectory() -> URL? {
    // 1) Embedded runtime — makes the .app transportable (works from anywhere).
    // 2) The folder the .app lives in (dev checkout).
    // 3) This Mac's known project folder (legacy).
    let candidates = [
        Bundle.main.resourceURL?.appendingPathComponent("runtime"),
        Bundle.main.bundleURL.deletingLastPathComponent(),
        URL(fileURLWithPath: "/Volumes/AI_DRIVE/cable app"),
    ]
    for dir in candidates {
        if let dir = dir,
           FileManager.default.fileExists(atPath: dir.appendingPathComponent("server.cjs").path) {
            return dir
        }
    }
    return nil
}

private func findNodeBinary() -> URL? {
    // A Node binary bundled inside the app (Contents/Resources/runtime/node)
    // makes the .app fully standalone — no install required on the target Mac.
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("runtime/node"),
       FileManager.default.isExecutableFile(atPath: bundled.path) {
        return bundled
    }
    let candidates = [
        "/opt/homebrew/opt/node/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
        return URL(fileURLWithPath: path)
    }
    return nil
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadRetries = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        showStarting()
        bringToFront()

        DispatchQueue.global(qos: .userInitiated).async {
            let ok = ensureServerRunning()
            DispatchQueue.main.async {
                if ok {
                    self.loadDashboard()
                } else {
                    self.showError("Could not start the Cable Speed Monitor server.")
                }
            }
        }
    }

    private func bringToFront() {
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // WebKit navigation — surface load failures instead of a silent blank
    // window, and bring the window forward once the dashboard is in.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        bringToFront()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        retryLoad()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        retryLoad()
    }

    private func retryLoad() {
        guard loadRetries < 5 else {
            showError("Dashboard did not load after 5 attempts. Check that the server on :8787 is running.")
            return
        }
        loadRetries += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.webView.load(URLRequest(url: URL(string: "http://localhost:8787")!))
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // If this app instance started the server (transportable mode), stop it on
    // quit. When the LaunchAgent is providing the server, we leave it alone.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if startedServerPID > 0 {
            kill(startedServerPID, SIGTERM)
        }
        return .terminateNow
    }

    // MARK: - UI

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "About Cable Speed Monitor",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit Cable Speed Monitor",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appItem.submenu = appMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        let reloadItem = NSMenuItem(title: "Reload Dashboard", action: #selector(reload), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1100, height: 740)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Cable Speed Monitor"
        window.minSize = NSSize(width: 720, height: 520)
        window.center()
        window.setFrameAutosaveName("CableSpeedMonitorWindow")

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: rect, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsMagnification = true
        window.contentView = webView

        bringToFront()
    }

    @objc private func reload() {
        webView.reload()
    }

    private func loadDashboard() {
        loadRetries = 0
        webView.load(URLRequest(url: URL(string: "http://localhost:8787")!))
    }

    private func showStarting() {
        webView.loadHTMLString(
            """
            <!DOCTYPE html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#05060a;color:#a1a1a6;font-family:-apple-system,sans-serif;font-size:15px">
            <div style="text-align:center">⚡ Cable Speed Monitor<br><span style="color:#6e6e73;font-size:12px">starting server…</span></div>
            </body></html>
            """,
            baseURL: nil
        )
    }

    private func showError(_ message: String) {
        webView.loadHTMLString(
            """
            <!DOCTYPE html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#05060a;color:#ff453a;font-family:-apple-system,sans-serif;font-size:15px;text-align:center;padding:20px">
            <div>⚠️ \(message)<br><span style="color:#6e6e73;font-size:12px">Check that Node.js is installed and the project folder exists.</span></div>
            </body></html>
            """,
            baseURL: nil
        )
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
