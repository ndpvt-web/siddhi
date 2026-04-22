import AppKit
import CoreGraphics

protocol CursorTrackerDelegate: AnyObject {
    func cursorMoved(x: Int, y: Int)
    func cursorClicked(x: Int, y: Int)
}

class CursorTracker {

    weak var delegate: CursorTrackerDelegate?

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    // Rate limiting: max 60 calls/sec
    private var lastMovedTimestamp: TimeInterval = 0
    private let minInterval: TimeInterval = 1.0 / 60.0

    init() {
        NSLog("[AtlasOverlay] CursorTracker: initialized")
    }

    func start() {
        let eventMask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
                let tracker = Unmanaged<CursorTracker>.fromOpaque(refcon).takeUnretainedValue()
                tracker.handleEvent(type: type, event: event)
                return Unmanaged.passUnretained(event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            NSLog("[AtlasOverlay] CursorTracker: WARNING - CGEventTap creation failed. Accessibility permission required.")
            return
        }

        self.eventTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        NSLog("[AtlasOverlay] CursorTracker: event tap started")
    }

    func stop() {
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        eventTap = nil
        runLoopSource = nil
        NSLog("[AtlasOverlay] CursorTracker: stopped")
    }

    private func handleEvent(type: CGEventType, event: CGEvent) {
        let location = event.location

        // Screen coordinates: CGEvent uses top-left origin on macOS (same as our protocol convention)
        let x = Int(location.x)
        let y = Int(location.y)

        switch type {
        case .mouseMoved, .leftMouseDragged:
            let now = Date().timeIntervalSince1970
            guard now - lastMovedTimestamp >= minInterval else { return }
            lastMovedTimestamp = now
            DispatchQueue.main.async { [weak self] in
                self?.delegate?.cursorMoved(x: x, y: y)
            }

        case .leftMouseDown:
            DispatchQueue.main.async { [weak self] in
                self?.delegate?.cursorClicked(x: x, y: y)
            }

        default:
            break
        }
    }
}
