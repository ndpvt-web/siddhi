import AppKit
import QuartzCore

enum HighlightStyle {
    case pulse
    case solid
}

class TargetHighlight: CAShapeLayer {

    private let screenHeight: CGFloat

    override init() {
        screenHeight = NSScreen.main?.frame.height ?? 900
        super.init()
        setupLayer()
        NSLog("[AtlasOverlay] TargetHighlight: initialized")
    }

    required init?(coder: NSCoder) {
        screenHeight = NSScreen.main?.frame.height ?? 900
        super.init(coder: coder)
        setupLayer()
    }

    override init(layer: Any) {
        screenHeight = NSScreen.main?.frame.height ?? 900
        super.init(layer: layer)
    }

    private func setupLayer() {
        self.fillColor = NSColor.clear.cgColor
        self.strokeColor = NSColor(hex: "#00d4ff")?.withAlphaComponent(0.5).cgColor
        self.lineWidth = 2.0
        self.opacity = 0
        self.masksToBounds = false
    }

    func show(x: Int, y: Int, w: Int, h: Int, style: HighlightStyle) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Convert from screen coordinates (top-left origin) to AppKit (bottom-left origin)
            let appKitY = self.screenHeight - CGFloat(y) - CGFloat(h)
            let padding: CGFloat = 6
            let rect = CGRect(
                x: CGFloat(x) - padding,
                y: appKitY - padding,
                width: CGFloat(w) + padding * 2,
                height: CGFloat(h) + padding * 2
            )

            let cornerRadius: CGFloat = 6
            let path = CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
            self.path = path

            self.removeAllAnimations()
            self.opacity = 1

            switch style {
            case .solid:
                self.strokeColor = NSColor(hex: "#00d4ff")?.withAlphaComponent(0.5).cgColor
                self.lineWidth = 2.0

            case .pulse:
                self.strokeColor = NSColor(hex: "#00d4ff")?.withAlphaComponent(0.5).cgColor
                self.lineWidth = 2.0
                self.startPulseAnimation(rect: rect, cornerRadius: cornerRadius)
            }

            NSLog("[AtlasOverlay] TargetHighlight: show at (%d,%d) size %dx%d style %@", x, y, w, h, String(describing: style))
        }
    }

    private func startPulseAnimation(rect: CGRect, cornerRadius: CGFloat) {
        let expandedRect = rect.insetBy(dx: -8, dy: -8)
        let expandedPath = CGPath(roundedRect: expandedRect, cornerWidth: cornerRadius + 4, cornerHeight: cornerRadius + 4, transform: nil)
        let originalPath = self.path

        let pathAnim = CABasicAnimation(keyPath: "path")
        pathAnim.fromValue = originalPath
        pathAnim.toValue = expandedPath
        pathAnim.duration = 1.2
        pathAnim.autoreverses = true
        pathAnim.repeatCount = .infinity
        pathAnim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)

        let opacityAnim = CABasicAnimation(keyPath: "opacity")
        opacityAnim.fromValue = 0.7
        opacityAnim.toValue = 0.2
        opacityAnim.duration = 1.2
        opacityAnim.autoreverses = true
        opacityAnim.repeatCount = .infinity
        opacityAnim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)

        self.add(pathAnim, forKey: "pulsePath")
        self.add(opacityAnim, forKey: "pulseOpacity")
    }

    func clear() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let fadeOut = CABasicAnimation(keyPath: "opacity")
            fadeOut.fromValue = self.opacity
            fadeOut.toValue = 0.0
            fadeOut.duration = 0.3
            fadeOut.fillMode = .forwards
            fadeOut.isRemovedOnCompletion = false

            CATransaction.begin()
            CATransaction.setCompletionBlock { [weak self] in
                self?.removeAllAnimations()
                self?.opacity = 0
                self?.path = nil
            }
            self.add(fadeOut, forKey: "fadeOut")
            CATransaction.commit()

            NSLog("[AtlasOverlay] TargetHighlight: clear")
        }
    }
}
