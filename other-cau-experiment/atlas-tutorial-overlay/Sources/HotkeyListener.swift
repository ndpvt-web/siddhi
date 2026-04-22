import AppKit
import CoreGraphics

protocol HotkeyListenerDelegate: AnyObject {
    func hotkeyPressed()
}

class HotkeyListener {

    weak var delegate: HotkeyListenerDelegate?

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    // Keycode 0 = 'A' on macOS keyboard layout
    private let targetKeyCode: Int64 = 0

    init() {
        NSLog("[AtlasOverlay] HotkeyListener: initialized")
    }

    func start() {
        let eventMask: CGEventMask = (1 << CGEventType.keyDown.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: eventMask,
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
                let listener = Unmanaged<HotkeyListener>.fromOpaque(refcon).takeUnretainedValue()
                return listener.handleKeyEvent(proxy: proxy, type: type, event: event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            NSLog("[AtlasOverlay] HotkeyListener: WARNING - CGEventTap creation failed. Accessibility permission required.")
            return
        }

        self.eventTap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        NSLog("[AtlasOverlay] HotkeyListener: event tap started, listening for Cmd+Shift+A")
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
        NSLog("[AtlasOverlay] HotkeyListener: stopped")
    }

    private func handleKeyEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        guard type == .keyDown else {
            return Unmanaged.passUnretained(event)
        }

        let flags = event.flags
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

        let hasCommand = flags.contains(.maskCommand)
        let hasShift = flags.contains(.maskShift)
        let isKeyA = keyCode == targetKeyCode

        if hasCommand && hasShift && isKeyA {
            NSLog("[AtlasOverlay] HotkeyListener: Cmd+Shift+A detected, suppressing event")
            DispatchQueue.main.async { [weak self] in
                self?.delegate?.hotkeyPressed()
            }
            // Return nil to suppress the event (keystroke won't reach active app)
            return nil
        }

        return Unmanaged.passUnretained(event)
    }
}
