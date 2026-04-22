import AppKit
import QuartzCore

enum PointerState {
    case idle
    case listening
    case thinking
    case onTarget
    case success
    case error
}

enum MoveStyle {
    case guide
    case snap
}

class GhostPointer: CALayer {

    private var currentState: PointerState = .idle
    private var previousState: PointerState = .idle

    // Sub-layers for various states
    private let circleLayer = CAShapeLayer()
    private let ringLayer = CAShapeLayer()
    private var thinkingDots: [CALayer] = []

    // Screen height for coordinate conversion
    private let screenHeight: CGFloat

    override init() {
        screenHeight = NSScreen.main?.frame.height ?? 900
        super.init()
        setupLayers()
        NSLog("[AtlasOverlay] GhostPointer: initialized")
    }

    required init?(coder: NSCoder) {
        screenHeight = NSScreen.main?.frame.height ?? 900
        super.init(coder: coder)
        setupLayers()
    }

    override init(layer: Any) {
        screenHeight = NSScreen.main?.frame.height ?? 900
        super.init(layer: layer)
    }

    private func setupLayers() {
        self.frame = CGRect(x: 0, y: 0, width: 80, height: 80)
        self.masksToBounds = false

        // Main circle layer
        circleLayer.frame = self.bounds
        circleLayer.fillColor = NSColor(hex: "#58a6ff")?.withAlphaComponent(0.3).cgColor
        circleLayer.shadowColor = NSColor.black.cgColor
        circleLayer.shadowOpacity = 0.4
        circleLayer.shadowOffset = CGSize(width: 0, height: -2)
        circleLayer.shadowRadius = 4
        updateCirclePath(radius: 8)
        addSublayer(circleLayer)

        // Ring layer (for onTarget state)
        ringLayer.frame = self.bounds
        ringLayer.fillColor = NSColor.clear.cgColor
        ringLayer.strokeColor = NSColor(hex: "#00d4ff")?.withAlphaComponent(0.5).cgColor
        ringLayer.lineWidth = 2
        ringLayer.opacity = 0
        addSublayer(ringLayer)

        // Thinking dots
        for i in 0..<3 {
            let dot = CALayer()
            dot.bounds = CGRect(x: 0, y: 0, width: 8, height: 8)
            dot.cornerRadius = 4
            dot.backgroundColor = NSColor(hex: "#00d4ff")?.withAlphaComponent(0.8).cgColor
            dot.opacity = 0
            _ = i  // suppress unused warning; positions set in startThinkingAnimation
            addSublayer(dot)
            thinkingDots.append(dot)
        }
    }

    private func updateCirclePath(radius: CGFloat) {
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let path = CGMutablePath()
        path.addEllipse(in: CGRect(
            x: center.x - radius, y: center.y - radius,
            width: radius * 2, height: radius * 2
        ))
        circleLayer.path = path
    }

    // MARK: - Coordinate Conversion

    private func toAppKitY(_ screenY: CGFloat) -> CGFloat {
        return screenHeight - screenY
    }

    // MARK: - Public Methods

    func setState(_ state: PointerState) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.previousState = self.currentState
            self.currentState = state
            self.applyState(state)
            NSLog("[AtlasOverlay] GhostPointer: setState %@", String(describing: state))
        }
    }

    func moveTo(x: Int, y: Int, duration: TimeInterval, style: MoveStyle) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let appKitY = self.toAppKitY(CGFloat(y))
            let targetPos = CGPoint(x: CGFloat(x), y: appKitY)

            switch style {
            case .snap:
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                self.position = targetPos
                CATransaction.commit()

            case .guide:
                let moveDuration = max(0.4, min(0.7, duration))
                let anim = CABasicAnimation(keyPath: "position")
                anim.toValue = targetPos
                anim.duration = moveDuration
                anim.timingFunction = CAMediaTimingFunction(name: .easeOut)
                anim.fillMode = .forwards
                anim.isRemovedOnCompletion = false
                self.add(anim, forKey: "moveGuide")
                self.position = targetPos
            }
        }
    }

    func followCursor(x: Int, y: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let appKitY = self.toAppKitY(CGFloat(y))
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.08)
            CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
            self.position = CGPoint(x: CGFloat(x), y: appKitY)
            CATransaction.commit()
        }
    }

    // MARK: - State Application

    private func applyState(_ state: PointerState) {
        stopAllStateAnimations()

        switch state {
        case .idle:
            applyIdleState()
        case .listening:
            applyListeningState()
        case .thinking:
            applyThinkingState()
        case .onTarget:
            applyOnTargetState()
        case .success:
            applyFlashState(color: "#3fb950", then: previousState)
        case .error:
            applyErrorState()
        }
    }

    private func stopAllStateAnimations() {
        circleLayer.removeAllAnimations()
        ringLayer.removeAllAnimations()
        ringLayer.opacity = 0
        for dot in thinkingDots {
            dot.removeAllAnimations()
            dot.opacity = 0
        }
    }

    private func applyIdleState() {
        circleLayer.opacity = 1
        circleLayer.fillColor = NSColor(hex: "#58a6ff")?.withAlphaComponent(0.3).cgColor
        updateCirclePath(radius: 8)
    }

    private func applyListeningState() {
        circleLayer.opacity = 1
        circleLayer.fillColor = NSColor(hex: "#00d4ff")?.withAlphaComponent(0.6).cgColor
        updateCirclePath(radius: 12)

        let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
        pulse.values = [1.0, 1.15, 1.0]
        pulse.keyTimes = [0, 0.5, 1.0]
        pulse.duration = 1.5
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        circleLayer.add(pulse, forKey: "pulse")
    }

    private func applyThinkingState() {
        circleLayer.opacity = 0
        startThinkingAnimation()
    }

    private func startThinkingAnimation() {
        let orbitRadius: CGFloat = 20
        let center = CGPoint(x: bounds.midX, y: bounds.midY)

        for (i, dot) in thinkingDots.enumerated() {
            dot.opacity = 1
            let startAngle = (CGFloat(i) / 3.0) * 2 * CGFloat.pi

            let positions = (0...24).map { step -> NSValue in
                let angle = startAngle + (CGFloat(step) / 24.0) * 2 * CGFloat.pi
                let px = center.x + orbitRadius * cos(angle)
                let py = center.y + orbitRadius * sin(angle)
                return NSValue(point: CGPoint(x: px, y: py))
            }

            let anim = CAKeyframeAnimation(keyPath: "position")
            anim.values = positions
            anim.duration = 2.0
            anim.repeatCount = .infinity
            anim.calculationMode = .paced
            dot.add(anim, forKey: "orbit")
            dot.position = center
        }
    }

    private func applyOnTargetState() {
        circleLayer.opacity = 1
        circleLayer.fillColor = NSColor(hex: "#00d4ff")?.withAlphaComponent(0.8).cgColor
        updateCirclePath(radius: 12)
        startExpandingRingAnimation()
    }

    private func startExpandingRingAnimation() {
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let startRadius: CGFloat = 12
        let endRadius: CGFloat = 40

        let startPath = CGMutablePath()
        startPath.addEllipse(in: CGRect(
            x: center.x - startRadius, y: center.y - startRadius,
            width: startRadius * 2, height: startRadius * 2
        ))

        let endPath = CGMutablePath()
        endPath.addEllipse(in: CGRect(
            x: center.x - endRadius, y: center.y - endRadius,
            width: endRadius * 2, height: endRadius * 2
        ))

        ringLayer.path = startPath
        ringLayer.opacity = 0.6

        let pathAnim = CABasicAnimation(keyPath: "path")
        pathAnim.fromValue = startPath
        pathAnim.toValue = endPath
        pathAnim.duration = 2.0
        pathAnim.repeatCount = .infinity
        pathAnim.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let opacityAnim = CABasicAnimation(keyPath: "opacity")
        opacityAnim.fromValue = 0.6
        opacityAnim.toValue = 0.0
        opacityAnim.duration = 2.0
        opacityAnim.repeatCount = .infinity
        opacityAnim.timingFunction = CAMediaTimingFunction(name: .easeOut)

        let group = CAAnimationGroup()
        group.animations = [pathAnim, opacityAnim]
        group.duration = 2.0
        group.repeatCount = .infinity

        ringLayer.opacity = 0
        ringLayer.add(group, forKey: "expandRing")
        ringLayer.opacity = 0
    }

    private func applyFlashState(color: String, then returnState: PointerState) {
        let flashColor = NSColor(hex: color)?.withAlphaComponent(0.9).cgColor
        circleLayer.opacity = 1
        circleLayer.fillColor = flashColor
        updateCirclePath(radius: 12)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self = self else { return }
            self.applyState(returnState)
        }
    }

    private func applyErrorState() {
        let errorColor = NSColor(hex: "#f85149")?.withAlphaComponent(0.9).cgColor
        circleLayer.opacity = 1
        circleLayer.fillColor = errorColor
        updateCirclePath(radius: 12)

        let shake = CAKeyframeAnimation(keyPath: "position.x")
        shake.values = [position.x, position.x + 3, position.x - 3, position.x + 3, position.x - 3, position.x]
        shake.keyTimes = [0, 0.2, 0.4, 0.6, 0.8, 1.0]
        shake.duration = 0.3
        add(shake, forKey: "shake")

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else { return }
            self.applyState(self.previousState)
        }
    }
}

// MARK: - NSColor hex extension

extension NSColor {
    convenience init?(hex: String) {
        var hexString = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if hexString.hasPrefix("#") {
            hexString = String(hexString.dropFirst())
        }
        guard hexString.count == 6,
              let value = UInt64(hexString, radix: 16) else { return nil }
        let r = CGFloat((value >> 16) & 0xFF) / 255.0
        let g = CGFloat((value >> 8) & 0xFF) / 255.0
        let b = CGFloat(value & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, alpha: 1.0)
    }
}
