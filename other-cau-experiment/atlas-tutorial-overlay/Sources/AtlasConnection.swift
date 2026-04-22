import Foundation

protocol AtlasConnectionDelegate: AnyObject {
    func connectionStateChanged(connected: Bool)
    func receivedPointerMove(x: Int, y: Int, style: String, duration: Int)
    func receivedPointerState(state: String)
    func receivedHighlight(x: Int, y: Int, w: Int, h: Int, style: String)
    func receivedHighlightClear()
    func receivedAnnotation(text: String, x: Int, y: Int, duration: Int)
    func receivedProgress(step: Int, total: Int, label: String)
    func receivedNarrate(text: String, duration: Int)
    func receivedDismiss()
    func receivedEngineError(message: String, severity: String)
}

class AtlasConnection: NSObject, URLSessionWebSocketDelegate {

    weak var delegate: AtlasConnectionDelegate?

    private let serverURL = URL(string: "ws://localhost:7888/tutorial/ws")!
    private let tokenFilePath = "/Users/nivesh/Projects/atlas-copy/.token"
    private let userDefaultsTokenKey = "AtlasConnectionToken"

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession!

    private var isConnected = false
    private var shouldReconnect = true
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 5
    private let reconnectDelays: [TimeInterval] = [2, 4, 8, 16, 30]

    // Rate limiting for cursor position sends: 30/sec
    private var lastCursorSendTime: TimeInterval = 0
    private let minCursorInterval: TimeInterval = 1.0 / 30.0

    override init() {
        super.init()
        urlSession = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue.main)
        NSLog("[AtlasOverlay] AtlasConnection: initialized")
    }

    // MARK: - Connection Management

    func connect() {
        shouldReconnect = true
        reconnectAttempts = 0
        openConnection()
    }

    func disconnect() {
        shouldReconnect = false
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        isConnected = false
    }

    private func openConnection() {
        var request = URLRequest(url: serverURL)

        // Load token from file or UserDefaults
        if let token = loadToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let task = urlSession.webSocketTask(with: request)
        self.webSocketTask = task
        task.resume()

        NSLog("[AtlasOverlay] AtlasConnection: connecting to %@", serverURL.absoluteString)
        startReceiveLoop()
    }

    private func loadToken() -> String? {
        // Try file first
        if let data = try? Data(contentsOf: URL(fileURLWithPath: tokenFilePath)),
           let token = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty {
            return token
        }
        // Fall back to UserDefaults
        return UserDefaults.standard.string(forKey: userDefaultsTokenKey)
    }

    private func scheduleReconnect() {
        guard shouldReconnect && reconnectAttempts < maxReconnectAttempts else {
            NSLog("[AtlasOverlay] AtlasConnection: max reconnect attempts reached, giving up")
            return
        }

        let delay = reconnectAttempts < reconnectDelays.count ? reconnectDelays[reconnectAttempts] : reconnectDelays.last!
        reconnectAttempts += 1

        NSLog("[AtlasOverlay] AtlasConnection: scheduling reconnect attempt %d in %.1fs", reconnectAttempts, delay)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.shouldReconnect else { return }
            self.openConnection()
        }
    }

    // MARK: - Receive Loop

    private func startReceiveLoop() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.parseMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.parseMessage(text)
                    }
                @unknown default:
                    break
                }
                // Continue receiving
                self.startReceiveLoop()

            case .failure(let error):
                NSLog("[AtlasOverlay] AtlasConnection: receive error: %@", error.localizedDescription)
                self.handleDisconnect()
            }
        }
    }

    private func handleDisconnect() {
        guard isConnected else { return }
        isConnected = false
        delegate?.connectionStateChanged(connected: false)
        scheduleReconnect()
    }

    // MARK: - Message Parsing

    private func parseMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            NSLog("[AtlasOverlay] AtlasConnection: failed to parse message: %@", text.prefix(200).description)
            return
        }

        NSLog("[AtlasOverlay] AtlasConnection: received message type=%@", type)

        switch type {
        case "pointer_move":
            let x = json["x"] as? Int ?? 0
            let y = json["y"] as? Int ?? 0
            let style = json["style"] as? String ?? "guide"
            let duration = json["duration"] as? Int ?? 500
            delegate?.receivedPointerMove(x: x, y: y, style: style, duration: duration)

        case "pointer_state":
            let state = json["state"] as? String ?? "idle"
            delegate?.receivedPointerState(state: state)

        case "highlight":
            let x = json["x"] as? Int ?? 0
            let y = json["y"] as? Int ?? 0
            let w = json["w"] as? Int ?? 0
            let h = json["h"] as? Int ?? 0
            let style = json["style"] as? String ?? "pulse"
            delegate?.receivedHighlight(x: x, y: y, w: w, h: h, style: style)

        case "highlight_clear":
            delegate?.receivedHighlightClear()

        case "annotation":
            let text = json["text"] as? String ?? ""
            let x = json["x"] as? Int ?? 0
            let y = json["y"] as? Int ?? 0
            let duration = json["duration"] as? Int ?? 0
            delegate?.receivedAnnotation(text: text, x: x, y: y, duration: duration)

        case "progress":
            let step = json["step"] as? Int ?? 0
            let total = json["total"] as? Int ?? 0
            let label = json["label"] as? String ?? ""
            delegate?.receivedProgress(step: step, total: total, label: label)

        case "narrate":
            let text = json["text"] as? String ?? ""
            let duration = json["duration"] as? Int ?? 3000
            delegate?.receivedNarrate(text: text, duration: duration)

        case "dismiss":
            delegate?.receivedDismiss()

        case "engine_error":
            let message = json["message"] as? String ?? ""
            let severity = json["severity"] as? String ?? "error"
            delegate?.receivedEngineError(message: message, severity: severity)

        default:
            NSLog("[AtlasOverlay] AtlasConnection: unknown message type: %@", type)
        }
    }

    // MARK: - Send Methods

    func sendCursorPosition(x: Int, y: Int) {
        let now = Date().timeIntervalSince1970
        guard now - lastCursorSendTime >= minCursorInterval else { return }
        lastCursorSendTime = now

        send(["type": "cursor_position", "x": x, "y": y])
    }

    func sendHotkeyActivated() {
        send(["type": "hotkey_activated"])
    }

    func sendHotkeyDeactivated() {
        send(["type": "hotkey_deactivated"])
    }

    func sendAudioChunk(data: Data) {
        let base64 = data.base64EncodedString()
        send(["type": "audio_chunk", "data": base64])
    }

    func sendAudioEnd() {
        send(["type": "audio_end"])
    }

    func sendUserClicked(x: Int, y: Int) {
        send(["type": "user_clicked", "x": x, "y": y])
    }

    private func send(_ dict: [String: Any]) {
        guard isConnected, let task = webSocketTask else { return }

        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else {
            NSLog("[AtlasOverlay] AtlasConnection: failed to serialize message")
            return
        }

        task.send(.string(text)) { error in
            if let error = error {
                NSLog("[AtlasOverlay] AtlasConnection: send error: %@", error.localizedDescription)
            }
        }
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        NSLog("[AtlasOverlay] AtlasConnection: connected")
        isConnected = true
        reconnectAttempts = 0
        delegate?.connectionStateChanged(connected: true)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) } ?? "none"
        NSLog("[AtlasOverlay] AtlasConnection: closed with code %d reason: %@", closeCode.rawValue, reasonStr)
        handleDisconnect()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            NSLog("[AtlasOverlay] AtlasConnection: task completed with error: %@", error.localizedDescription)
            handleDisconnect()
        }
    }
}
