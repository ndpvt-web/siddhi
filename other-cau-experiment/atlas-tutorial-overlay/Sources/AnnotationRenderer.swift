import AppKit

class AnnotationRenderer: NSView {

    private let screenHeight: CGFloat
    private let screenWidth: CGFloat
    private var annotations: [NSView] = []
    private var subtitleView: NSView?
    private var subtitleTimer: Timer?

    init() {
        let screen = NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        screenHeight = screen.height
        screenWidth = screen.width
        super.init(frame: screen)
        self.wantsLayer = true
        self.layer?.backgroundColor = NSColor.clear.cgColor
        NSLog("[AtlasOverlay] AnnotationRenderer: initialized")
    }

    required init?(coder: NSCoder) {
        screenHeight = NSScreen.main?.frame.height ?? 900
        screenWidth = NSScreen.main?.frame.width ?? 1440
        super.init(coder: coder)
    }

    // MARK: - Annotation Bubble

    func showAnnotation(text: String, x: Int, y: Int, duration: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let bubble = self.makeBubble(text: text, maxWidth: 280)

            // Convert screen Y to AppKit Y
            let appKitY = self.screenHeight - CGFloat(y)

            // Position near (x, y) with nudge to avoid screen edges
            var originX = CGFloat(x) + 12
            var originY = appKitY - bubble.frame.height / 2

            // Nudge to keep inside screen bounds
            if originX + bubble.frame.width > self.screenWidth - 10 {
                originX = CGFloat(x) - bubble.frame.width - 12
            }
            if originY < 10 { originY = 10 }
            if originY + bubble.frame.height > self.screenHeight - 10 {
                originY = self.screenHeight - bubble.frame.height - 10
            }

            bubble.frame = CGRect(x: originX, y: originY, width: bubble.frame.width, height: bubble.frame.height)
            bubble.alphaValue = 0

            self.addSubview(bubble)
            self.annotations.append(bubble)

            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                bubble.animator().alphaValue = 1.0
            }

            if duration > 0 {
                let ms = duration
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self, weak bubble] in
                    guard let bubble = bubble else { return }
                    self?.fadeBubbleOut(bubble)
                }
            }

            NSLog("[AtlasOverlay] AnnotationRenderer: showAnnotation at (%d,%d) duration=%dms", x, y, duration)
        }
    }

    // MARK: - Subtitle

    func showSubtitle(text: String, duration: Int) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Remove existing subtitle
            self.subtitleTimer?.invalidate()
            self.subtitleTimer = nil
            if let existing = self.subtitleView {
                existing.removeFromSuperview()
                self.subtitleView = nil
            }

            let maxWidth: CGFloat = 600
            let subtitle = self.makeBubble(text: text, maxWidth: maxWidth)

            // Center horizontally, 80px from bottom
            let originX = (self.screenWidth - subtitle.frame.width) / 2
            let originY: CGFloat = 80

            subtitle.frame = CGRect(x: originX, y: originY, width: subtitle.frame.width, height: subtitle.frame.height)
            subtitle.alphaValue = 0

            self.addSubview(subtitle)
            self.subtitleView = subtitle

            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                subtitle.animator().alphaValue = 1.0
            }

            if duration > 0 {
                let timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(duration) / 1000.0, repeats: false) { [weak self, weak subtitle] _ in
                    guard let subtitle = subtitle else { return }
                    self?.fadeBubbleOut(subtitle)
                    self?.subtitleView = nil
                }
                self.subtitleTimer = timer
            }

            NSLog("[AtlasOverlay] AnnotationRenderer: showSubtitle duration=%dms", duration)
        }
    }

    // MARK: - Clear All

    func clearAnnotations() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            self.subtitleTimer?.invalidate()
            self.subtitleTimer = nil

            let allViews = self.annotations + (self.subtitleView.map { [$0] } ?? [])
            self.annotations.removeAll()
            self.subtitleView = nil

            for view in allViews {
                self.fadeBubbleOut(view)
            }

            NSLog("[AtlasOverlay] AnnotationRenderer: clearAnnotations")
        }
    }

    // MARK: - Helpers

    private func makeBubble(text: String, maxWidth: CGFloat) -> NSView {
        let padding: CGFloat = 12
        let font = NSFont.systemFont(ofSize: 13, weight: .regular)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]

        let constraintSize = CGSize(width: maxWidth - padding * 2, height: CGFloat.greatestFiniteMagnitude)
        let textSize = (text as NSString).boundingRect(
            with: constraintSize,
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: attrs,
            context: nil
        ).size

        let bubbleWidth = min(textSize.width + padding * 2 + 4, maxWidth)
        let bubbleHeight = textSize.height + padding * 2

        let container = NSView(frame: CGRect(x: 0, y: 0, width: bubbleWidth, height: bubbleHeight))
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.086, green: 0.106, blue: 0.133, alpha: 0.85).cgColor
        container.layer?.cornerRadius = 8

        let label = NSTextField(frame: CGRect(
            x: padding, y: padding,
            width: bubbleWidth - padding * 2,
            height: textSize.height + 2
        ))
        label.stringValue = text
        label.font = font
        label.textColor = .white
        label.backgroundColor = .clear
        label.isBezeled = false
        label.isEditable = false
        label.isSelectable = false
        label.cell?.wraps = true
        label.cell?.isScrollable = false
        label.maximumNumberOfLines = 0

        container.addSubview(label)
        return container
    }

    private func fadeBubbleOut(_ view: NSView) {
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.25
            view.animator().alphaValue = 0
        }, completionHandler: {
            view.removeFromSuperview()
        })
        annotations.removeAll { $0 === view }
    }
}
