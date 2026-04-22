import AppKit
import Foundation

// MARK: - App Coordinator

final class AppCoordinator: NSObject {

    let overlayWindow: OverlayWindow
    let ghostPointer: GhostPointer
    let targetHighlight: TargetHighlight
    let cursorTracker: CursorTracker
    let hotkeyListener: HotkeyListener
    let micCapture: MicCapture
    let atlasConnection: AtlasConnection
    let annotationRenderer: AnnotationRenderer
    let progressIndicator: ProgressIndicator

    private var isSessionActive = false

    override init() {
        overlayWindow = OverlayWindow()
        ghostPointer = GhostPointer()
        targetHighlight = TargetHighlight()
        cursorTracker = CursorTracker()
        hotkeyListener = HotkeyListener()
        micCapture = MicCapture()
        atlasConnection = AtlasConnection()
        annotationRenderer = AnnotationRenderer()
        progressIndicator = ProgressIndicator()

        super.init()

        wireComponents()
        NSLog("[AtlasOverlay] AppCoordinator: all components initialized and wired")
    }

    private func wireComponents() {
        // Add layers to overlay window
        overlayWindow.addPointerLayer(targetHighlight)
        overlayWindow.addPointerLayer(ghostPointer)

        // Add views to overlay window
        overlayWindow.addOverlaySubview(annotationRenderer)
        overlayWindow.addOverlaySubview(progressIndicator)

        // Set delegates
        cursorTracker.delegate = self
        hotkeyListener.delegate = self
        micCapture.delegate = self
        atlasConnection.delegate = self

        // Start background components
        cursorTracker.start()
        hotkeyListener.start()
        atlasConnection.connect()

        // Show the overlay window
        overlayWindow.makeKeyAndOrderFront(nil)
        ghostPointer.setState(.idle)

        NSLog("[AtlasOverlay] AppCoordinator: overlay window shown, trackers started")
    }
}

// MARK: - CursorTrackerDelegate

extension AppCoordinator: CursorTrackerDelegate {

    func cursorMoved(x: Int, y: Int) {
        if !isSessionActive {
            ghostPointer.followCursor(x: x, y: y)
        }
        // Always forward cursor position to server when connected
        atlasConnection.sendCursorPosition(x: x, y: y)
    }

    func cursorClicked(x: Int, y: Int) {
        atlasConnection.sendUserClicked(x: x, y: y)
        NSLog("[AtlasOverlay] AppCoordinator: user clicked at (%d,%d)", x, y)
    }
}

// MARK: - HotkeyListenerDelegate

extension AppCoordinator: HotkeyListenerDelegate {

    func hotkeyPressed() {
        isSessionActive.toggle()
        NSLog("[AtlasOverlay] AppCoordinator: hotkey pressed, session active=%@", isSessionActive ? "true" : "false")

        if isSessionActive {
            atlasConnection.sendHotkeyActivated()
            ghostPointer.setState(.listening)
            micCapture.startCapture()
        } else {
            atlasConnection.sendHotkeyDeactivated()
            micCapture.stopCapture()
            ghostPointer.setState(.idle)
            annotationRenderer.clearAnnotations()
            progressIndicator.hide()
        }
    }
}

// MARK: - MicCaptureDelegate

extension AppCoordinator: MicCaptureDelegate {

    func audioChunk(data: Data) {
        atlasConnection.sendAudioChunk(data: data)
    }

    func audioEnded() {
        atlasConnection.sendAudioEnd()
        ghostPointer.setState(.thinking)
        NSLog("[AtlasOverlay] AppCoordinator: audio ended, switching to thinking state")
    }
}

// MARK: - AtlasConnectionDelegate

extension AppCoordinator: AtlasConnectionDelegate {

    func connectionStateChanged(connected: Bool) {
        NSLog("[AtlasOverlay] AppCoordinator: connection state changed: %@", connected ? "connected" : "disconnected")
        if !connected && isSessionActive {
            // Reset session state on disconnect
            isSessionActive = false
            micCapture.stopCapture()
            ghostPointer.setState(.idle)
        }
    }

    func receivedPointerMove(x: Int, y: Int, style: String, duration: Int) {
        let moveStyle: MoveStyle = style == "snap" ? .snap : .guide
        let durationSeconds = TimeInterval(duration) / 1000.0
        ghostPointer.moveTo(x: x, y: y, duration: durationSeconds, style: moveStyle)
    }

    func receivedPointerState(state: String) {
        let pointerState: PointerState
        switch state {
        case "idle":       pointerState = .idle
        case "listening":  pointerState = .listening
        case "thinking":   pointerState = .thinking
        case "onTarget":   pointerState = .onTarget
        case "success":    pointerState = .success
        case "error":      pointerState = .error
        default:
            NSLog("[AtlasOverlay] AppCoordinator: unknown pointer state: %@", state)
            pointerState = .idle
        }
        ghostPointer.setState(pointerState)
    }

    func receivedHighlight(x: Int, y: Int, w: Int, h: Int, style: String) {
        let highlightStyle: HighlightStyle = style == "solid" ? .solid : .pulse
        targetHighlight.show(x: x, y: y, w: w, h: h, style: highlightStyle)
    }

    func receivedHighlightClear() {
        targetHighlight.clear()
    }

    func receivedAnnotation(text: String, x: Int, y: Int, duration: Int) {
        annotationRenderer.showAnnotation(text: text, x: x, y: y, duration: duration)
    }

    func receivedProgress(step: Int, total: Int, label: String) {
        progressIndicator.update(step: step, total: total, label: label)
    }

    func receivedNarrate(text: String, duration: Int) {
        // Show narration as a subtitle at the bottom of the screen
        annotationRenderer.showSubtitle(text: text, duration: duration)
    }

    func receivedDismiss() {
        isSessionActive = false
        micCapture.stopCapture()
        ghostPointer.setState(.idle)
        targetHighlight.clear()
        annotationRenderer.clearAnnotations()
        progressIndicator.hide()
        NSLog("[AtlasOverlay] AppCoordinator: dismiss received, session ended")
    }

    func receivedEngineError(message: String, severity: String) {
        NSLog("[AtlasOverlay] AppCoordinator: engine error [%@]: %@", severity, message)
        ghostPointer.setState(.error)

        // Show error annotation near center-bottom of screen
        let screenWidth = Int(NSScreen.main?.frame.width ?? 1440)
        let screenHeight = Int(NSScreen.main?.frame.height ?? 900)
        annotationRenderer.showAnnotation(text: message, x: screenWidth / 2, y: screenHeight - 100, duration: 4000)
    }
}

// MARK: - Entry Point

// Check accessibility permission
let options: NSDictionary = [kAXTrustedCheckOptionPrompt.takeRetainedValue() as NSString: true]
let accessibilityGranted = AXIsProcessTrustedWithOptions(options)

if !accessibilityGranted {
    NSLog("[AtlasOverlay] main: Accessibility permission not granted. CGEventTap features will be unavailable.")

    let alert = NSAlert()
    alert.messageText = "Atlas Tutorial Overlay"
    alert.informativeText = "Accessibility permission is required for cursor tracking and hotkey support.\n\nPlease grant permission in System Settings > Privacy & Security > Accessibility, then restart the app."
    alert.alertStyle = .warning
    alert.addButton(withTitle: "Continue Anyway")
    alert.addButton(withTitle: "Open System Settings")

    let response = alert.runModal()
    if response == .alertSecondButtonReturn {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
}

// Set up app
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Create and hold coordinator
let coordinator = AppCoordinator()

NSLog("[AtlasOverlay] main: Starting run loop")
app.run()
