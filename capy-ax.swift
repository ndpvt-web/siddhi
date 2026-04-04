#!/usr/bin/env swift
// capy-ax.swift - macOS Accessibility Tree Reader
// Reads UI elements from frontmost application via AX API
// Usage: capy-ax <command> [args...]
// Commands: clickable, tree [depth], text-fields, focused, frontapp

import Cocoa
import ApplicationServices

// MARK: - AX Element Helpers

func axValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var value: AnyObject?
    AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return value
}

func axStringValue(_ element: AXUIElement, _ attr: String) -> String? {
    axValue(element, attr) as? String
}

func axPosition(_ element: AXUIElement) -> CGPoint? {
    guard let val = axValue(element, kAXPositionAttribute) else { return nil }
    var point = CGPoint.zero
    if AXValueGetValue(val as! AXValue, .cgPoint, &point) { return point }
    return nil
}

func axSize(_ element: AXUIElement) -> CGSize? {
    guard let val = axValue(element, kAXSizeAttribute) else { return nil }
    var size = CGSize.zero
    if AXValueGetValue(val as! AXValue, .cgSize, &size) { return size }
    return nil
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let children = axValue(element, kAXChildrenAttribute) as? [AXUIElement] else { return [] }
    return children
}

func axRole(_ element: AXUIElement) -> String? {
    axStringValue(element, kAXRoleAttribute)
}

func axTitle(_ element: AXUIElement) -> String? {
    axStringValue(element, kAXTitleAttribute)
}

func axDescription(_ element: AXUIElement) -> String? {
    axStringValue(element, kAXDescriptionAttribute)
}

func axRoleDescription(_ element: AXUIElement) -> String? {
    axStringValue(element, kAXRoleDescriptionAttribute)
}

// MARK: - Frontmost App

func frontmostApp() -> (pid: pid_t, name: String, element: AXUIElement)? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = app.processIdentifier
    let name = app.localizedName ?? "Unknown"
    let element = AXUIElementCreateApplication(pid)
    return (pid, name, element)
}

// MARK: - Element to JSON dict

func elementToDict(_ el: AXUIElement) -> [String: Any] {
    var d: [String: Any] = [:]
    d["role"] = axRole(el) ?? "unknown"
    if let title = axTitle(el), !title.isEmpty { d["title"] = title }
    if let desc = axDescription(el), !desc.isEmpty { d["description"] = desc }
    if let roleDesc = axRoleDescription(el), !roleDesc.isEmpty { d["roleDescription"] = roleDesc }
    if let val = axStringValue(el, kAXValueAttribute), !val.isEmpty {
        d["value"] = String(val.prefix(200))
    }
    if let pos = axPosition(el), let size = axSize(el) {
        d["x"] = Int(pos.x)
        d["y"] = Int(pos.y)
        d["width"] = Int(size.width)
        d["height"] = Int(size.height)
    }
    if let enabled = axValue(el, kAXEnabledAttribute) as? Bool { d["enabled"] = enabled }
    if let focused = axValue(el, kAXFocusedAttribute) as? Bool { d["focused"] = focused }
    if let sub = axStringValue(el, kAXSubroleAttribute), !sub.isEmpty { d["subrole"] = sub }
    return d
}

// MARK: - Clickable Elements

let clickableRoles: Set<String> = [
    "AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXTab", "AXTabGroup",
    "AXToolbar", "AXDisclosureTriangle", "AXIncrementor", "AXSlider",
    "AXColorWell", "AXImage", "AXStaticText", "AXCell", "AXTextField",
    "AXTextArea", "AXSegmentedControl"
]

func collectClickable(_ element: AXUIElement, _ results: inout [[String: Any]], maxDepth: Int = 10, depth: Int = 0) {
    guard depth < maxDepth else { return }
    let role = axRole(element) ?? ""
    if clickableRoles.contains(role) {
        if let _ = axPosition(element) {
            results.append(elementToDict(element))
        }
    }
    for child in axChildren(element) {
        collectClickable(child, &results, maxDepth: maxDepth, depth: depth + 1)
    }
}

// MARK: - Text Fields

func collectTextFields(_ element: AXUIElement, _ results: inout [[String: Any]], maxDepth: Int = 10, depth: Int = 0) {
    guard depth < maxDepth else { return }
    let role = axRole(element) ?? ""
    if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" || role == "AXSearchField" {
        if let _ = axPosition(element) {
            results.append(elementToDict(element))
        }
    }
    for child in axChildren(element) {
        collectTextFields(child, &results, maxDepth: maxDepth, depth: depth + 1)
    }
}

// MARK: - Full Tree

func buildTree(_ element: AXUIElement, maxDepth: Int = 5, depth: Int = 0) -> [String: Any] {
    var d = elementToDict(element)
    if depth < maxDepth {
        let children = axChildren(element)
        if !children.isEmpty {
            d["children"] = children.map { buildTree($0, maxDepth: maxDepth, depth: depth + 1) }
        }
    }
    return d
}

// MARK: - Focused Element

func focusedElement(_ appElement: AXUIElement) -> [String: Any]? {
    guard let focused = axValue(appElement, kAXFocusedUIElementAttribute) as! AXUIElement? else { return nil }
    return elementToDict(focused)
}

// MARK: - JSON Output

func jsonString(_ obj: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else {
        return "{\"error\": \"JSON serialization failed\"}"
    }
    return String(data: data, encoding: .utf8) ?? "{\"error\": \"UTF8 conversion failed\"}"
}

// MARK: - Main

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("{\"error\": \"Usage: capy-ax <command> [args...] Commands: clickable, tree [depth], text-fields, focused, frontapp\"}")
    exit(1)
}

let command = args[1]

// Check AX trusted
guard AXIsProcessTrusted() else {
    print("{\"error\": \"Accessibility not trusted. Grant access in System Preferences > Privacy & Security > Accessibility\"}")
    exit(1)
}

guard let app = frontmostApp() else {
    print("{\"error\": \"No frontmost application found\"}")
    exit(1)
}

switch command {
case "clickable":
    var results: [[String: Any]] = []
    collectClickable(app.element, &results)
    let output: [String: Any] = ["app": app.name, "pid": app.pid, "clickable": results, "count": results.count]
    print(jsonString(output))

case "tree":
    let depth = args.count >= 3 ? Int(args[2]) ?? 5 : 5
    let tree = buildTree(app.element, maxDepth: depth)
    let output: [String: Any] = ["app": app.name, "pid": app.pid, "tree": tree]
    print(jsonString(output))

case "text-fields":
    var results: [[String: Any]] = []
    collectTextFields(app.element, &results)
    let output: [String: Any] = ["app": app.name, "pid": app.pid, "textFields": results, "count": results.count]
    print(jsonString(output))

case "focused":
    if let focused = focusedElement(app.element) {
        let output: [String: Any] = ["app": app.name, "pid": app.pid, "focused": focused]
        print(jsonString(output))
    } else {
        print("{\"app\": \"\(app.name)\", \"pid\": \(app.pid), \"focused\": null}")
    }

case "frontapp":
    let output: [String: Any] = ["app": app.name, "pid": app.pid]
    print(jsonString(output))

default:
    print("{\"error\": \"Unknown command: \(command). Use: clickable, tree, text-fields, focused, frontapp\"}")
    exit(1)
}
