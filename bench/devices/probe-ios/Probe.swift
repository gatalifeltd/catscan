// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Probe app for bench/devices/ios-profiles.mjs (TODO-073 D2): a white full screen, no status bar, home indicator
// kept visible. The launch argument `-orientation portrait|landscape-left|landscape-right` turns the scene with the
// public UIWindowScene.requestGeometryUpdate. `-items <json>` also draws labels and icon buttons for the rendered
// set of bench/safe-area/rendered.mjs and reports their frames and glyph rects (points). `-wrap <json>` instead shows
// the TODO-074 wrapping screen (WrapController). Apache 2.0, built with swiftc by the scripts (no Xcode project).
import UIKit

final class ProbeController: UIViewController {
    let mask: UIInterfaceOrientationMask
    init(mask: UIInterfaceOrientationMask) { self.mask = mask; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError() }
    struct Spec: Decodable {
        let id: String; let text: String?; let size: Double
        let left: Double?; let right: Double?; let centerX: Double?; let top: Double?; let bottom: Double?; let centerY: Double?
    }
    var items: [(Spec, UIView)] = []

    override func loadView() {
        view = UIView()
        view.backgroundColor = .white
        // Base64 JSON: the argument domain would parse a raw "[...]" value as a property list.
        guard let j = UserDefaults.standard.string(forKey: "items"), let d = Data(base64Encoded: j),
              let specs = try? JSONDecoder().decode([Spec].self, from: d) else { return }
        for s in specs {
            let v: UIView
            if let t = s.text {
                let l = UILabel()
                l.text = t
                l.font = .systemFont(ofSize: s.size)
                l.textColor = .black
                v = l
            } else {
                let b = UIButton(type: .system)
                b.setImage(UIImage(systemName: "xmark.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: s.size)), for: .normal)
                b.tintColor = .darkGray
                v = b
            }
            view.addSubview(v)
            items.append((s, v))
        }
    }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { false }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { mask }
    // Writes what UIKit reports (scale, bounds, safe area) to Documents/probe.json for the script to read.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard view.window != nil else { return }
        var out: [[String: Any]] = []
        for (s, v) in items {
            let z = v.sizeThatFits(CGSize(width: 10000, height: 10000))
            let x = s.left ?? s.right.map { $0 - z.width } ?? ((s.centerX ?? 0) - z.width / 2)
            let y = s.top ?? s.bottom.map { $0 - z.height } ?? ((s.centerY ?? 0) - z.height / 2)
            v.frame = CGRect(x: x, y: y, width: z.width, height: z.height)
            var glyphs: [[String: Any]] = []
            if let l = v as? UILabel, let t = l.text {
                // TextKit glyph rects in the label's coordinates (the label sizes to its text, so no centering offset).
                let storage = NSTextStorage(string: t, attributes: [.font: l.font!])
                let lm = NSLayoutManager(), tc = NSTextContainer(size: CGSize(width: 10000, height: 10000))
                tc.lineFragmentPadding = 0
                lm.addTextContainer(tc)
                storage.addLayoutManager(lm)
                let ns = t as NSString
                var i = 0
                while i < ns.length {
                    let r = ns.rangeOfComposedCharacterSequence(at: i)
                    let g = lm.glyphRange(forCharacterRange: r, actualCharacterRange: nil)
                    let b = lm.boundingRect(forGlyphRange: g, in: tc)
                    glyphs.append(["ch": ns.substring(with: r), "rect": [x + b.minX, y + b.minY, b.width, b.height]])
                    i = NSMaxRange(r)
                }
            }
            out.append(["id": s.id, "frame": [x, y, z.width, z.height], "glyphs": glyphs])
        }
        let i = view.safeAreaInsets, s = view.window?.windowScene?.screen ?? UIScreen.main
        let o: [String: Any] = ["scale": s.scale, "nativeScale": s.nativeScale, "width": view.bounds.width, "height": view.bounds.height,
                                "safe": [i.top, i.left, i.bottom, i.right],
                                "orientation": view.window?.windowScene?.interfaceOrientation.rawValue ?? 0, "items": out]
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let d = try? JSONSerialization.data(withJSONObject: o) else { return }
        try? d.write(to: dir.appendingPathComponent("probe.json"))
    }
}

// TODO-074 rendered positives (bench/wrapping/rendered.mjs): one screen of native controls whose labels come from
// `-wrap <base64 json>` (rows of {kind, id, text, items}), so the same layout renders the en and the pseudo strings.
// Buttons and chips wrap (UIButton.Configuration titles take any number of lines); a segmented control, a tab bar
// and a navigation bar title stay on one line and truncate, as UIKit draws them. Every element carries its id as
// accessibilityIdentifier, the key that pairs it with its en twin.
final class WrapController: UIViewController {
    struct Item: Decodable { let kind: String; let id: String; let text: String?; let items: [Item]? }
    let rows: [[Item]]
    var placed: [[(Item, UIView)]] = []
    init(rows: [[Item]]) { self.rows = rows; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError() }

    func make(_ it: Item) -> UIView {
        let v: UIView
        switch it.kind {
        case "nav":
            let b = UINavigationBar()
            let n = UINavigationItem(title: it.text ?? "")
            n.leftBarButtonItem = UIBarButtonItem(systemItem: .close)
            b.setItems([n], animated: false)
            v = b
        case "tabs":
            let b = UITabBar()
            let symbols = ["house", "magnifyingglass", "books.vertical", "person"]
            b.items = (it.items ?? []).enumerated().map { i, t in
                let x = UITabBarItem(title: t.text, image: UIImage(systemName: symbols[i % symbols.count]), tag: i)
                x.accessibilityIdentifier = t.id
                return x
            }
            b.selectedItem = b.items?.first
            v = b
        case "segment":
            let s = UISegmentedControl(items: (it.items ?? []).map { $0.text ?? "" })
            s.selectedSegmentIndex = 0
            v = s
        case "button", "chip":
            var c: UIButton.Configuration = it.kind == "chip" ? .tinted() : .filled()
            if it.kind == "chip" { c.cornerStyle = .capsule }
            c.title = it.text
            v = UIButton(configuration: c)
        default: // title, subtitle
            let l = UILabel()
            l.text = it.text
            l.numberOfLines = 0
            l.font = it.kind == "title" ? .systemFont(ofSize: 28, weight: .bold) : .systemFont(ofSize: 17)
            l.textColor = it.kind == "title" ? .black : .darkGray
            v = l
        }
        v.accessibilityIdentifier = it.id
        return v
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .white
        placed = rows.map { $0.map { ($0, make($0)) } }
        for r in placed { for (_, v) in r { view.addSubview(v) } }
    }
    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let W = view.bounds.width, H = view.bounds.height, safe = view.safeAreaInsets
        var y = safe.top
        for r in placed {
            if r.count == 1, r[0].0.kind == "tabs" {
                let h = r[0].1.sizeThatFits(CGSize(width: W, height: 100)).height
                r[0].1.frame = CGRect(x: 0, y: H - h, width: W, height: h)
                continue
            }
            if r.count == 1, r[0].0.kind == "nav" {
                r[0].1.frame = CGRect(x: 0, y: y, width: W, height: 44)
                y += 44 + 12
                continue
            }
            let gap: CGFloat = 8, n = CGFloat(r.count), w = ((W - 32 - gap * (n - 1)) / n).rounded(.down)
            var rowH: CGFloat = 0
            for (i, (_, v)) in r.enumerated() {
                let h = v.sizeThatFits(CGSize(width: w, height: 10000)).height
                v.frame = CGRect(x: 16 + CGFloat(i) * (w + gap), y: y, width: w, height: h)
                rowH = max(rowH, h)
            }
            y += rowH + 16
        }
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let arg = UserDefaults.standard.string(forKey: "orientation") ?? "portrait"
        // UIKit names landscape by the interface: landscape-left is the device turned with the cutout on the left,
        // which is UIInterfaceOrientation.landscapeRight (home button / indicator side on the right edge of the device).
        let mask: UIInterfaceOrientationMask = arg == "landscape-left" ? .landscapeRight : arg == "landscape-right" ? .landscapeLeft : .portrait
        let w = UIWindow(windowScene: ws)
        if let j = UserDefaults.standard.string(forKey: "wrap"), let d = Data(base64Encoded: j),
           let rows = try? JSONDecoder().decode([[WrapController.Item]].self, from: d) {
            w.rootViewController = WrapController(rows: rows)
        } else {
            w.rootViewController = ProbeController(mask: mask)
        }
        w.makeKeyAndVisible()
        window = w
        ws.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting s: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let c = UISceneConfiguration(name: nil, sessionRole: s.role)
        c.delegateClass = SceneDelegate.self
        return c
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
