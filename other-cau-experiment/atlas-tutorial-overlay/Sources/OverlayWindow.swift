import AppKit
import QuartzCore

class OverlayWindow: NSWindow {

    private let rootContentView: NSView

    init() {
        let screenFrame = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)

        rootContentView = NSView(frame: screenFrame)
        rootContentView.wantsLayer = true
        rootContentView.layer?.backgroundColor = NSColor.clear.cgColor

        super.init(
            contentRect: screenFrame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )

        self.level = .floating
        self.ignoresMouseEvents = true
        self.backgroundColor = NSColor.clear
        self.isOpaque = false
        self.hasShadow = false
        self.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        self.contentView = rootContentView
        self.isReleasedWhenClosed = false

        NSLog("[AtlasOverlay] OverlayWindow: initialized with frame %@", NSStringFromRect(screenFrame))
    }

    /// Add a CALayer as a sublayer to the content view's layer (for ghost pointer etc.)
    func addPointerLayer(_ layer: CALayer) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.rootContentView.layer?.addSublayer(layer)
            NSLog("[AtlasOverlay] OverlayWindow: addPointerLayer called")
        }
    }

    /// Add an NSView as a subview of the content view
    func addOverlaySubview(_ view: NSView) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.rootContentView.addSubview(view)
            NSLog("[AtlasOverlay] OverlayWindow: addSubview %@", String(describing: type(of: view)))
        }
    }
}
