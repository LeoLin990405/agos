// AgOS.app —— AgOS 前端的原生外壳(macOS / Swift + WKWebView)
//
// 设计取舍:
//   · 零新依赖:不引 Electron(省 200MB 运行时),不引 Tauri(省 Rust 工具链),
//     只用系统自带的 AppKit + WebKit。产物就是一个几百 KB 的 .app。
//   · 零宿主篡改:后端不 patch、不改 asar,而是**用官方入口** `dsh web` 以无头方式
//     起一个 web profile(它自带我们全部插件,其中 dsh-agos 在 /agos 提供 SPA)。
//   · 单实例纪律:DSH 的会话目录不允许两个实例同时写,所以启动前先确认端口没人占,
//     退出时把自己拉起的后端一并收掉。

import AppKit
import WebKit

// MARK: - 配置

enum Config {
    /// 后端候选端口。3091 排第一是有意的:DSH Desktop 正在跑时就**复用**它的后端,
    /// 而不是另起一个 —— 两个实例同时写 ~/.dsh/sessions 会互相踩(见 ~/bin/dsh-desktop 的说明)。
    /// 它没在跑时,3091 空闲,我们就自己在这个端口起 `dsh web`,对前端而言地址不变。
    static let portCandidates: [UInt16] = [3091, 3096, 3097, 3098, 3099]
    /// 等待后端就绪的上限(秒)。
    static let bootTimeout: TimeInterval = 40
    /// 注入 API key 的环境文件(与 ~/bin/dsh-desktop 同源;GUI 启动拿不到 shell 环境)。
    static let envFiles = [
        "\(NSHomeDirectory())/.config/cc-model-secrets.env",
        "\(NSHomeDirectory())/.m2-api-env.zsh",
    ]
    static let dshBin = "\(NSHomeDirectory())/.npm-global/bin/dsh"
}

// MARK: - 端口探测

func isPortFree(_ port: UInt16) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var yes: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return bound == 0
}

func httpOK(_ url: URL, timeout: TimeInterval = 2) -> Bool {
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    request.httpMethod = "HEAD"
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, response, _ in
        if let http = response as? HTTPURLResponse, http.statusCode < 500 { ok = true }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + timeout + 1)
    return ok
}

// MARK: - 后端

/// 把 zsh 风格的 env 文件读成键值对(只认 `export K=V` 与 `K=V`,不执行任何命令)。
func loadEnvFile(_ path: String) -> [String: String] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
        var line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") { continue }
        if line.hasPrefix("export ") { line = String(line.dropFirst("export ".count)) }
        guard let eq = line.firstIndex(of: "=") else { continue }
        let key = String(line[line.startIndex..<eq]).trimmingCharacters(in: .whitespaces)
        var value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
        if value.count >= 2,
           (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
            value = String(value.dropFirst().dropLast())
        }
        // 跳过含命令替换/变量展开的行:我们不做 shell 求值,宁可不注入也不猜。
        if value.contains("$(") || value.contains("`") { continue }
        if key.isEmpty { continue }
        out[key] = value
    }
    return out
}

final class Backend {
    private var process: Process?
    private(set) var port: UInt16 = 0
    /// 后端是本 App 拉起的(true)还是复用了已在跑的实例(false)。
    private(set) var owned = false

    /// 返回可用的 base URL;若已有实例在跑就直接复用(不重复拉起,避免双写会话目录)。
    func start() -> URL? {
        for candidate in Config.portCandidates where !isPortFree(candidate) {
            if httpOK(URL(string: "http://127.0.0.1:\(candidate)/agos/")!) {
                port = candidate
                owned = false
                return URL(string: "http://127.0.0.1:\(candidate)/agos/")
            }
        }
        guard let free = Config.portCandidates.first(where: { isPortFree($0) }) else { return nil }
        port = free

        var env = ProcessInfo.processInfo.environment
        for file in Config.envFiles {
            for (k, v) in loadEnvFile(file) { env[k] = v }
        }
        // SPA 用 App 包内自带的那份,而不是开发工作区里的
        // 开发工作区的 dist(历史上曾在 ~/Documents —— macOS TCC 保护目录,
        // 未获「文件与文件夹」授权的 App 及其子进程读它会被卡住(静态路由挂起、
        // 而 /api/* 照常响应,现象非常有迷惑性)。包内 Resources 不受 TCC 管辖。
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web").path,
           FileManager.default.fileExists(atPath: bundled) {
            env["DSH_AGOS_DIST"] = bundled
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: Config.dshBin)
        task.arguments = ["web", "--port", String(free), "--no-open", "--host", "127.0.0.1"]
        task.environment = env
        // 后端日志落文件:丢进 /dev/null 会让启动失败变成沉默的黑洞,排障时无从下手。
        let logPath = "\(NSHomeDirectory())/Library/Logs/AgOS-backend.log"
        FileManager.default.createFile(atPath: logPath, contents: nil)
        if let handle = FileHandle(forWritingAtPath: logPath) {
            task.standardOutput = handle
            task.standardError = handle
        }
        do { try task.run() } catch { return nil }
        process = task
        owned = true

        let url = URL(string: "http://127.0.0.1:\(free)/agos/")!
        let deadline = Date().addingTimeInterval(Config.bootTimeout)
        while Date() < deadline {
            if httpOK(url) { return url }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return nil
    }

    func stop() {
        guard owned, let task = process, task.isRunning else { return }
        task.terminate()
        // 给它 3 秒收摊(要落盘会话),超时再强杀。
        let deadline = Date().addingTimeInterval(3)
        while task.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if task.isRunning { kill(task.processIdentifier, SIGKILL) }
    }
}

// MARK: - 主窗口

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let backend = Backend()
    private var statusLabel: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let url = self.backend.start()
            DispatchQueue.main.async {
                guard let url else {
                    self.showFailure()
                    return
                }
                self.statusLabel.isHidden = true
                self.webView.load(URLRequest(url: url))
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        backend.stop()
    }

    private func buildWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "AgOS"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 1080, height: 680)
        window.setFrameAutosaveName("AgOSMainWindow")
        window.center()

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: frame, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        statusLabel = NSTextField(labelWithString: "正在启动本地舰队…")
        statusLabel.alignment = .center
        statusLabel.font = .systemFont(ofSize: 13)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.frame = NSRect(x: 0, y: frame.midY - 12, width: frame.width, height: 24)
        statusLabel.autoresizingMask = [.width, .minYMargin, .maxYMargin]

        let container = NSView(frame: frame)
        container.addSubview(webView)
        container.addSubview(statusLabel)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showFailure() {
        statusLabel.stringValue = "本地舰队未能启动 —— 请检查 dsh 是否可用,或端口是否被占用。"
        statusLabel.textColor = .systemRed
    }

    // MARK: 菜单

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 AgOS", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 AgOS", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 AgOS", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        let newSession = NSMenuItem(title: "新会话", action: #selector(newSession(_:)), keyEquivalent: "k")
        newSession.target = self
        fileMenu.addItem(newSession)
        fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        let reload = NSMenuItem(title: "重新载入", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        let devtools = NSMenuItem(title: "开发者工具", action: #selector(toggleDevTools(_:)), keyEquivalent: "i")
        devtools.keyEquivalentModifierMask = [.command, .option]
        devtools.target = self
        viewMenu.addItem(devtools)
        viewMenu.addItem(.separator())
        let zoomIn = NSMenuItem(title: "放大", action: #selector(zoomIn(_:)), keyEquivalent: "+")
        zoomIn.target = self
        viewMenu.addItem(zoomIn)
        let zoomOut = NSMenuItem(title: "缩小", action: #selector(zoomOut(_:)), keyEquivalent: "-")
        zoomOut.target = self
        viewMenu.addItem(zoomOut)
        let zoomReset = NSMenuItem(title: "实际大小", action: #selector(zoomReset(_:)), keyEquivalent: "0")
        zoomReset.target = self
        viewMenu.addItem(zoomReset)
        viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        mainMenu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    /// 菜单里的「新会话」与 SPA 内的 ⌘K 走同一条事件通道(前端已在监听 agos:new-session)。
    @objc private func newSession(_ sender: Any?) {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('agos:new-session'))", completionHandler: nil)
    }

    @objc private func reloadPage(_ sender: Any?) { webView.reload() }

    @objc private func toggleDevTools(_ sender: Any?) {
        // WKWebView 的检查器由 developerExtrasEnabled 打开后走右键菜单「检查元素」。
        webView.evaluateJavaScript("void 0", completionHandler: nil)
        NSSound.beep()
    }

    @objc private func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 2.0) }
    @objc private func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.6) }
    @objc private func zoomReset(_ sender: Any?) { webView.pageZoom = 1.0 }

    // MARK: WKNavigationDelegate

    /// 外链一律交给系统浏览器,窗口里只留本机 SPA。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let isLocal = url.host == "127.0.0.1" || url.host == "localhost"
        if isLocal || url.scheme == "about" || url.scheme == "data" {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        statusLabel.isHidden = false
        statusLabel.stringValue = "页面载入失败:\(error.localizedDescription)"
        statusLabel.textColor = .systemRed
    }
}

// MARK: - 入口

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
