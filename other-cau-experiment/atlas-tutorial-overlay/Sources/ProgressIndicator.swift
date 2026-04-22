import AppKit

class ProgressIndicator: NSView {

    private let label: NSTextField
    private let screenHeight: CGFloat
    private let screenWidth: CGFloat
    private let margin: CGFloat = 20

    init() {
        let screen = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        screenHeight = screen.height
        screenWidth = screen.width

        label = NSTextField()
        label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = .clear
        label.isBezeled = false
        label.isEditable = false
        label.isSelectable = false
        label.alignment = .right

        // Initial size - will be adjusted on update
        let initialFrame = CGRect(x: 0, y: 0, width: 200, height: 32)
        super.init(frame: initialFrame)

        self.wantsLayer = true
        self.layer?.backgroundColor = NSColor(red: 0.086, green: 0.106, blue: 0.133, alpha: 0.85).cgColor
        self.layer?.cornerRadius = 6
        self.alphaValue = 0

        label.frame = CGRect(x: 10, y: 8, width: 180, height: 16)
        self.addSubview(label)

        NSLog("[AtlasOverlay] ProgressIndicator: initialized")
    }

    required init?(coder: NSCoder) {
        screenHeight = NSScreen.main?.frame.height ?? 900
        screenWidth = NSScreen.main?.frame.width ?? 1440
        label = NSTextField()
        super.init(coder: coder)
    }

    func update(step: Int, total: Int, label labelText: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let displayText: String
            if labelText.isEmpty {
                displayText = "Step \(step) of \(total)"
            } else {
                displayText = "Step \(step) of \(total) — \(labelText)"
            }

            self.label.stringValue = displayText

            // Size to fit text
            let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
            let attrs: [NSAttributedString.Key: Any] = [.font: font]
            let textSize = (displayText as NSString).size(withAttributes: attrs)
            let padding: CGFloat = 20
            let newWidth = textSize.width + padding * 2
            let newHeight: CGFloat = 32

            // Position: top-right corner, margin from edges
            // AppKit Y: top of screen = screenHeight, so top-right corner position
            let originX = self.screenWidth - newWidth - self.margin
            let originY = self.screenHeight - newHeight - self.margin

            self.frame = CGRect(x: originX, y: originY, width: newWidth, height: newHeight)
            self.label.frame = CGRect(x: padding, y: 8, width: newWidth - padding * 2, height: 16)

            self.show()

            NSLog("[AtlasOverlay] ProgressIndicator: update step=%d total=%d label=%@", step, total, labelText)
        }
    }

    func show() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                self.animator().alphaValue = 1.0
            }
        }
    }

    func hide() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.25
                self.animator().alphaValue = 0
            }
            NSLog("[AtlasOverlay] ProgressIndicator: hide")
        }
    }
}
