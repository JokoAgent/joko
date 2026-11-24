import Foundation
import Vision
import XCTest

// Real accessibility interactions with the shipped connection WebView. No
// injected JavaScript, mocked controls, external node or account is involved.
final class JokoConnectionUITests: XCTestCase {
    private var app: XCUIApplication!
    private var ownedLaunchArguments: [String] = []
    private var sdkRuntime = "relay"

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        let selected = environment["JOKO_CI_SDK_RUNTIME"] ?? "relay"
        guard ["relay", "iroh-native", "http-connect-native"].contains(selected) else {
            throw NSError(domain: "JokoCI", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown selected Mobile runtime."])
        }
        sdkRuntime = selected
        guard let metro = environment["JOKO_CI_METRO_PORT"], Int(metro) != nil,
              let probe = environment["JOKO_CI_PROBE_PORT"], Int(probe) != nil else {
            throw NSError(domain: "JokoCI", code: 1, userInfo: [NSLocalizedDescriptionKey: "Owned local servers were not passed to the UI runner."])
        }
        app = XCUIApplication(bundleIdentifier: "app.joko.mobile")
        let launchArguments = ["-RCT_jsLocation", "127.0.0.1:\(metro)", "-RCT_packager_scheme", "http", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        ownedLaunchArguments = launchArguments
        // The native owner has already launched, terminated, reopened and
        // observed this exact application. Do not create a third occurrence.
        app.launchArguments = launchArguments
        let priorState = app.state
        let running = priorState == .runningForeground || priorState == .runningBackground || priorState == .runningBackgroundSuspended
        if !running { try? recordPreInputSetupFailure(launchArguments: launchArguments) }
        XCTAssertTrue(running, "The already verified reopened application must still be running before activation.")
        guard running else { return }
        // Reuse the verified foreground occurrence without another synchronous
        // activation handoff. Background occurrences still need activation.
        if priorState != .runningForeground { app.activate() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        let nearbyExists = tab("Nearby").waitForExistence(timeout: 45)
        if !nearbyExists { try? recordPreInputSetupFailure(launchArguments: launchArguments) }
        XCTAssertTrue(nearbyExists)
        XCTAssertTrue(connectionPage.exists, "The real connection page must be present.")
        for label in ["Nearby", "Saved nodes", "Add Joko node"] {
            XCTAssertEqual(tabQuery(label).count, 1,
                           "The real connection page must own one exact \(label) control.")
        }
    }

    private func recordPreInputSetupFailure(launchArguments: [String], stage: String = "pre-input-setup") throws {
        // Every call site precedes any address or pairing input. Never attach a
        // later UI tree, including after a validation or transport operation.
        let prefix = stage == "pre-input-address" ? "00-address-pre-input" : "00-setup-pre-input"
        screenshot("\(prefix)-screen", reportProgress: false)
        let hierarchy = Data(app.debugDescription.utf8)
        let boundedHierarchy = Data(hierarchy.prefix(128 * 1024))
        let state: [String: Any] = [
            "stage": stage, "connectionInputNotStarted": true,
            "configuredBundleIdentifier": "app.joko.mobile",
            "configuredLaunchArgumentsMatchOwnedServers": app.launchArguments == launchArguments,
            "ownedMetroPortReceived": true, "ownedProbePortReceived": true,
            "applicationState": app.state.rawValue, "webViewCount": app.webViews.count,
            "expectedControls": [
                "Nearby": ["buttons": app.buttons.matching(identifier: "Nearby").count,
                           "staticTexts": app.staticTexts.matching(identifier: "Nearby").count,
                           "allRoles": app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Nearby")).count],
                "Saved nodes": ["buttons": app.buttons.matching(identifier: "Saved nodes").count],
                "Add Joko node": ["buttons": app.buttons.matching(identifier: "Add Joko node").count]
            ],
            "hierarchyBytes": boundedHierarchy.count, "hierarchyTruncated": hierarchy.count > boundedHierarchy.count
        ]
        let controlState = XCTAttachment(data: try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
        controlState.name = "\(prefix)-state"
        controlState.lifetime = .keepAlways
        add(controlState)
        let tree = XCTAttachment(data: boundedHierarchy, uniformTypeIdentifier: "public.plain-text")
        tree.name = "\(prefix)-hierarchy"
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func screenshot(_ name: String, reportProgress: Bool = true) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if reportProgress { reportCheckpoint(name) }
    }

    private func reportCheckpoint(_ name: String) {
        if let probe = ProcessInfo.processInfo.environment["JOKO_CI_PROBE_PORT"],
           let url = URL(string: "http://127.0.0.1:\(probe)/ci-probe-progress/\(name)") {
            // xcodebuild may buffer its test output until completion. Report
            // only fixed checkpoint names to the owned loopback observer.
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 2
            URLSession.shared.dataTask(with: request).resume()
        }
    }

    private func wait(_ element: XCUIElement, _ predicate: String, timeout: TimeInterval = 10,
                      file: StaticString = #filePath, line: UInt = #line) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed,
                       "Connection control did not satisfy: \(predicate)", file: file, line: line)
    }

    private var connectionPage: XCUIElement { app.webViews.firstMatch }
    private func button(_ label: String) -> XCUIElement { connectionPage.buttons[label].firstMatch }
    // The shipped WKWebView exposes the segmented tabs as accessibility switches.
    // Keep the exact role/label query inside this application's connection page.
    private func tabQuery(_ label: String) -> XCUIElementQuery {
        connectionPage.switches.matching(NSPredicate(format: "label == %@", label))
    }
    private func tab(_ label: String) -> XCUIElement { tabQuery(label).firstMatch }

    private func tap(_ element: XCUIElement, atCenter: Bool = false, beforeConnectionInput: Bool = false) {
        // Debug builds can present native LogBox toasts over WKWebView controls.
        // Close those exact development surfaces through their real UI; keep
        // application errors, dialogs, and every connection assertion visible.
        for prefix in ["Open debugger to view warnings.", "[expo-notifications] Error reading persisted"] {
            // This native LogBox version exposes the combined icon and message
            // as Other, with the exact observed "!, " label prefix.
            let notice = app.descendants(matching: .any).matching(NSPredicate(
                format: "label BEGINSWITH %@ OR label BEGINSWITH %@", prefix, "!, \(prefix)")).firstMatch
            if notice.exists && notice.isHittable {
                // The installed SDK places the close button 10 points from
                // the window edge, plus 12 padding and half its 20-point width.
                // Use the window's horizontal bounds and this toast's actual Y.
                let window = app.windows.firstMatch
                let closeNotice = {
                    let frame = window.frame
                    let noticeFrame = notice.frame
                    XCTAssertGreaterThan(noticeFrame.width, 44)
                    window.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
                        dx: frame.width - 32, dy: noticeFrame.midY - frame.minY)).tap()
                }
                closeNotice()
                // A first native press can leave this exact toast present.
                // Re-measure and press at most once more inside the original
                // five-second disappearance budget; never ignore the overlay.
                let deadline = Date().addingTimeInterval(5)
                let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: notice)
                var result = XCTWaiter.wait(for: [dismissed], timeout: 1)
                if result != .completed && deadline.timeIntervalSinceNow > 0 {
                    if notice.exists && notice.isHittable && deadline.timeIntervalSinceNow > 0 {
                        closeNotice()
                    }
                    let remaining = deadline.timeIntervalSinceNow
                    if remaining > 0 {
                        let retry = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: notice)
                        result = XCTWaiter.wait(for: [retry], timeout: remaining)
                    }
                }
                // The final native tap can close the notice after the earlier
                // wait expires. Observe its actual state before continuing.
                let noticeStillPresent = notice.exists
                if noticeStillPresent && beforeConnectionInput {
                    try? recordPreInputSetupFailure(launchArguments: ownedLaunchArguments)
                }
                XCTAssertFalse(noticeStillPresent, "The actual development notice must close.")
            }
        }
        // WKWebView's page can scroll while the native keyboard is open. Scroll
        // the actual page to expose the control rather than tapping coordinates.
        // A hittable element is already present. Use one native accessibility
        // query on this path and sample again only after the UI has changed.
        if !element.isHittable {
            XCTAssertTrue(element.waitForExistence(timeout: 10))
            var hittable = element.isHittable
            for _ in 0..<4 where !hittable {
                connectionPage.swipeUp()
                hittable = element.isHittable
            }
            for _ in 0..<5 where !hittable {
                connectionPage.swipeDown()
                hittable = element.isHittable
            }
            XCTAssertTrue(hittable)
        }
        if atCenter {
            // Web controls can expose a native hit point outside the editable
            // area. Use the measured center of the exact labeled element.
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        } else {
            element.tap()
        }
    }

    @discardableResult
    private func dismissQuickPathIfPresent(until deadline: Date, checkSystemScreen: Bool = false) -> Bool {
        let guideText = "Speed up your typing by sliding your finger across the letters to compose a word."
        let guide = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", guideText)).firstMatch
        let dismissed: Bool
        let source: String
        if guide.exists {
            let proceed = app.buttons.matching(NSPredicate(format: "label == %@", "Continue")).firstMatch
            let window = app.windows.firstMatch
            let windowFrame = window.frame
            // XCTest can retire the system button during interruption handling.
            // Use its measured hit point from the app window while the guide is present.
            if proceed.waitForExistence(timeout: max(0, deadline.timeIntervalSinceNow)),
               let frame = try? proceed.snapshot().frame, !frame.isEmpty, windowFrame.contains(frame), guide.exists {
                window.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: frame.midX - windowFrame.minX, dy: frame.midY - windowFrame.minY)).tap()
            }
            let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: guide)
            dismissed = !guide.exists || XCTWaiter.wait(for: [gone], timeout: max(0, deadline.timeIntervalSinceNow)) == .completed
            source = "application-accessibility"
        } else {
            // The fresh Simulator can show QuickPath outside the application's
            // accessibility tree. Use the screen only for the first public address.
            guard checkSystemScreen, deadline.timeIntervalSinceNow > 0,
                  let observed = quickPathOnScreen(guideText), observed.guideVisible else { return false }
            guard let proceed = observed.continueButton, deadline.timeIntervalSinceNow > 0 else {
                XCTFail("The exact QuickPath guide must expose one visible Continue button below its text.")
                return false
            }
            app.coordinate(withNormalizedOffset: CGVector(dx: proceed.midX, dy: 1 - proceed.midY)).tap()
            var guideDisappeared = false
            while deadline.timeIntervalSinceNow > 0 {
                if let current = quickPathOnScreen(guideText), !current.guideVisible {
                    guideDisappeared = true
                    break
                }
                Thread.sleep(forTimeInterval: min(0.2, max(0, deadline.timeIntervalSinceNow)))
            }
            dismissed = guideDisappeared
            source = "system-screen"
        }
        if dismissed { reportCheckpoint("04-address-quickpath-dismissed") }
        let receipt: [String: Any] = ["scope": "owned-native-quickpath-guide-only",
            "guideText": guideText, "button": "Continue", "dismissed": dismissed, "source": source]
        if let data = try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]) {
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = "native-quickpath-guide-handled"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertTrue(dismissed, "The exact QuickPath guide must disappear after Continue.")
        return dismissed
    }

    private func quickPathOnScreen(_ guideText: String) -> (guideVisible: Bool, continueButton: CGRect?)? {
        guard let screenshot = XCUIScreen.main.screenshot().image.cgImage else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = false
        do { try VNImageRequestHandler(cgImage: screenshot).perform([request]) }
        catch { return nil }
        let lines = (request.results ?? []).compactMap { observation -> (text: String, bounds: CGRect)? in
            let bounds = observation.boundingBox
            guard bounds.midY < 0.4, let candidate = observation.topCandidates(1).first else { return nil }
            return (candidate.string.split(whereSeparator: \.isWhitespace).joined(separator: " "), bounds)
        }.sorted { $0.bounds.midY > $1.bounds.midY }
        let guideWords = guideText.split(separator: " ")
        for index in lines.indices {
            var words: [Substring] = []
            for line in lines[index...] {
                words.append(contentsOf: line.text.split(separator: " "))
                guard guideWords.starts(with: words) else { break }
                if words == guideWords {
                    let buttons = lines.filter { $0.text == "Continue" && $0.bounds.maxY < line.bounds.minY }
                    return (true, buttons.count == 1 ? buttons[0].bounds : nil)
                }
            }
        }
        return (false, nil)
    }

    private func recordPublicInputMismatch(_ field: XCUIElement, expected text: String, knownPublicInvitation: Bool,
                                           stage: String) {
        let probe = ProcessInfo.processInfo.environment["JOKO_CI_PROBE_PORT"] ?? ""
        let publicAddress = field.label == "Joko node address" && (text == "not-an-address"
            || (!probe.isEmpty && text == "http://127.0.0.1:\(probe)"))
        guard knownPublicInvitation || publicAddress else { return }
        // Only the owned public addresses and fixed .example invitation may
        // produce a bounded field receipt. Never attach a later UI tree.
        let observed = field.value
        let value = observed as? String
        let observedCharacters: Any = value.map { $0.count as Any } ?? NSNull()
        let observedText: Any = value.map { String($0.prefix(1024)) as Any } ?? NSNull()
        let diagnostic: [String: Any] = [
            "scope": knownPublicInvitation ? "fixed-public-connect-invitation-only" : "fixed-public-connection-address-only",
            "stage": stage,
            "hasFocus": field.hasFocus,
            "keyboardPresent": app.keyboards.firstMatch.exists,
            "valueType": observed.map { String(reflecting: type(of: $0)) } ?? "nil",
            "expectedCharacters": text.count,
            "observedCharacters": observedCharacters,
            "expectedValue": String(text.prefix(1024)),
            "observedValue": observedText,
            "valueTruncated": (value?.count ?? 0) > 1024
        ]
        if let data = try? JSONSerialization.data(withJSONObject: diagnostic, options: [.sortedKeys]) {
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
            attachment.name = knownPublicInvitation ? "11-http-connect-input-mismatch" : "04-public-address-input-mismatch"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    private func replace(_ field: XCUIElement, with text: String, knownPublicInvitation: Bool = false,
                         traceFirstAddressEntry: Bool = false) {
        tap(field, atCenter: true)
        if traceFirstAddressEntry { reportCheckpoint("04-address-tapped") }
        let keyboard = app.keyboards.firstMatch
        let focusDeadline = Date().addingTimeInterval(10)
        var dismissedGuide = dismissQuickPathIfPresent(until: focusDeadline)
        if !field.hasFocus && !keyboard.waitForExistence(timeout: min(2, max(0, focusDeadline.timeIntervalSinceNow)))
            && focusDeadline.timeIntervalSinceNow > 0 {
            tap(field, atCenter: true)
        }
        let keyboardReady = field.hasFocus || keyboard.waitForExistence(timeout: max(0, focusDeadline.timeIntervalSinceNow))
        dismissedGuide = dismissQuickPathIfPresent(until: focusDeadline, checkSystemScreen: traceFirstAddressEntry && keyboardReady)
            || dismissedGuide
        let readyToType = field.hasFocus || (keyboardReady && keyboard.exists)
        if !readyToType { recordPublicInputMismatch(field, expected: text, knownPublicInvitation: knownPublicInvitation, stage: "focus") }
        XCTAssertTrue(readyToType, "Tapping the native field must make text input available.")
        guard readyToType else { return }
        // WKWebView's default hit point and repeated taps can leave the caret
        // at the start without selecting text. Move to the trailing side of
        // this short, single-line address, then delete its observed characters
        // through the real keyboard and verify the empty value before typing.
        // WKWebView can report its placeholder as the value of an empty field
        // without exposing placeholderValue separately.
        let formPlaceholder = ["Joko node address": "http://192.168.1.20:4318",
                               "Trusted node invitation or public key": "ed25519:…",
                               "Pairing code": "XXXX-XXXX"][field.label] ?? ""
        let emptyValues = ["", field.placeholderValue ?? "", formPlaceholder]
        if let value = field.value as? String, !emptyValues.contains(value) {
            if field.elementType == .textView {
                // The preceding CONNECT invitation can wrap and scroll. Clear
                // its remaining visible suffix through the real caret before
                // replacing the public pin; never type over a partial draft.
                for _ in 0..<8 {
                    guard let remaining = field.value as? String, !emptyValues.contains(remaining) else { break }
                    field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.95)).tap()
                    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: remaining.count))
                }
            } else {
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
            }
            let cleared = XCTNSPredicateExpectation(predicate: NSPredicate(
                format: "exists == true AND (value == nil OR value IN %@)", argumentArray: [emptyValues]), object: field)
            let clearedResult = XCTWaiter.wait(for: [cleared], timeout: 10)
            XCTAssertEqual(clearedResult, .completed,
                           "The native address field must be empty before replacement.")
        }
        if traceFirstAddressEntry { reportCheckpoint("04-address-typing") }
        field.typeText(text)
        if traceFirstAddressEntry { reportCheckpoint("04-address-typed") }
        var valueDeadline = Date().addingTimeInterval(10)
        var restoredFirstEntry = false
        var valueMatches: Bool
        repeat {
            dismissedGuide = dismissQuickPathIfPresent(until: valueDeadline,
                checkSystemScreen: traceFirstAddressEntry && (field.value as? String) != text)
                || dismissedGuide
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
            let remaining = valueDeadline.timeIntervalSinceNow
            if remaining > 0 && (field.value as? String) != text {
                _ = XCTWaiter.wait(for: [changed], timeout: min(1, remaining))
            }
            // QuickPath can interrupt the first public address after a prefix.
            // Restore only the missing suffix once the system guide is gone.
            if traceFirstAddressEntry && dismissedGuide && !restoredFirstEntry,
               let observed = field.value as? String, observed != text {
                let prefix = emptyValues.contains(observed) ? "" : observed
                if text.hasPrefix(prefix) {
                    restoredFirstEntry = true
                    field.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                    let current = field.value as? String
                    if (current == prefix || (prefix.isEmpty && emptyValues.contains(current ?? ""))) && (field.hasFocus || keyboard.exists) {
                        field.typeText(String(text.dropFirst(prefix.count)))
                        reportCheckpoint("04-address-input-restored")
                    }
                    valueDeadline = Date().addingTimeInterval(10)
                }
            }
            valueMatches = (field.value as? String) == text
        } while !valueMatches && valueDeadline.timeIntervalSinceNow > 0
        if !valueMatches { recordPublicInputMismatch(field, expected: text, knownPublicInvitation: knownPublicInvitation, stage: "replace") }
        XCTAssertTrue(valueMatches, "The native field must contain the exact requested value.")
        // The URL keyboard's real Done accessory dismisses it. On a layout
        // without that accessory, tapping the form heading blurs the field.
        let done = app.buttons["Done"].firstMatch
        if done.exists && done.isHittable { done.tap() }
        else {
            let heading = connectionPage.staticTexts["Pair this device"].firstMatch
            tap(heading)
        }
    }

    private func waitForPendingRequest(_ port: String) throws {
        // Observe the owned server rather than cancelling before native fetch
        // has actually dispatched. This status endpoint never drives the app.
        let endpoint = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/ci-probe-status"))
        for _ in 0..<20 {
            let complete = XCTestExpectation(description: "Read only the local probe request count")
            var pending = false
            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 1
            let task = URLSession.shared.dataTask(with: request) { data, _, _ in
                if let data = data, let status = try? JSONSerialization.jsonObject(with: data) as? [String: Int] {
                    pending = status["identityRequests"] == 2
                }
                complete.fulfill()
            }
            task.resume()
            // A missed read belongs to this polling attempt. Only exhausting
            // the original loop fails the test; retire a timed-out read.
            if XCTWaiter.wait(for: [complete], timeout: 2) == .completed && pending { return }
            task.cancel()
            Thread.sleep(forTimeInterval: 0.2)
        }
        XCTFail("The second native identity request did not reach the owned local server.")
    }

    private func pdfFixtureInput(_ path: String, waitForCode: Bool = false) throws -> [String: String]? {
        let port = try XCTUnwrap(ProcessInfo.processInfo.environment["JOKO_CI_PROBE_PORT"])
        let endpoint = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/\(path)"))
        let deadline = Date().addingTimeInterval(20)
        repeat {
            let completed = XCTestExpectation(description: "Read the owned PDF task fixture")
            var input: [String: String]?
            var status: Int?
            var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
            request.httpMethod = "GET"
            let task = URLSession.shared.dataTask(with: request) { data, response, _ in
                status = (response as? HTTPURLResponse)?.statusCode
                if let data, status == 200 {
                    input = try? JSONSerialization.jsonObject(with: data) as? [String: String]
                }
                completed.fulfill()
            }
            task.resume()
            if XCTWaiter.wait(for: [completed], timeout: 3) == .completed {
                if let input { return input }
                if status == 204 && !waitForCode { return nil }
            }
            task.cancel()
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return try XCTUnwrap(nil as [String: String]?, "The owned PDF task fixture must return the expected input.")
    }

    private func visibleTextMenuAction(_ label: String, timeout: TimeInterval = 10) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        let exactLabel = NSPredicate(format: "label == %@", label)
        repeat {
            let actionInMenu = app.menuItems.matching(exactLabel).firstMatch
            let actionInApplication = app.descendants(matching: .any).matching(exactLabel).firstMatch
            for action in [actionInMenu, actionInApplication] {
                if action.exists && action.isHittable { return action }
            }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return nil
    }

    private func copyOriginalWorkspacePdf(_ inputs: [String: String]) throws {
        let origin = try XCTUnwrap(inputs["origin"])
        let key = try XCTUnwrap(inputs["publicKey"])
        let address = connectionPage.textFields["Joko node address"].firstMatch
        replace(address, with: origin)
        let pin = connectionPage.textViews["Trusted node invitation or public key"].firstMatch
        XCTAssertTrue(pin.waitForExistence(timeout: 10))
        replace(pin, with: key)
        reportCheckpoint("11-pdf-address-and-key-confirmed")
        let inspect = button("Check node identity")
        wait(inspect, "enabled == true")
        tap(inspect, atCenter: true)
        reportCheckpoint("11-pdf-identity-check-tapped")
        let identity = connectionPage.staticTexts["Identity: ios-workspace-pdf"].firstMatch
        // The first pinned check loads the HTTP and Noise chunks serially from
        // Debug Metro. Their cold build exceeded 25 seconds on the Intel runner.
        XCTAssertTrue(identity.waitForExistence(timeout: 60), "The owned PDF node identity was not shown after the native check.")
        reportCheckpoint("11-pdf-identity-confirmed")
        let request = button("Request pairing")
        wait(request, "enabled == true")
        reportCheckpoint("11-pdf-pairing-available")
        tap(request)
        let pairing = try XCTUnwrap(pdfFixtureInput("ci-pdf-pairing-code", waitForCode: true))
        let code = try XCTUnwrap(pairing["code"])
        let field = connectionPage.textFields["Pairing code"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        replace(field, with: code)
        tap(button("Pair this device"))

        let task = app.buttons["Open task Original workspace PDF task"].firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 35))
        tap(task)
        let link = app.links["Reference PDF"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 25), "The original task must display its Workspace PDF link.")
        reportCheckpoint("11-pdf-task-link-visible")
        tap(link)
        reportCheckpoint("11-pdf-task-link-tapped")
        let word = app.webViews.staticTexts["Quartz"].firstMatch
        XCTAssertTrue(word.waitForExistence(timeout: 35), "The actual PDF page must expose the Quartz text span.")
        XCTAssertTrue(word.isHittable)
        XCTAssertLessThan(word.frame.width, app.windows.firstMatch.frame.width / 2)
        XCTAssertTrue(app.buttons["Fit PDF pages to width"].firstMatch.exists)
        screenshot("11-original-workspace-pdf")
        let backToFiles = app.buttons["Back to Files"].firstMatch
        XCTAssertTrue(backToFiles.isHittable)
        // The header already has 16 points of padding, and the portrait status bar adds at least 20.
        XCTAssertGreaterThanOrEqual(backToFiles.frame.minY - app.windows.firstMatch.frame.minY, 36,
                                    "The PDF preview header must clear the iPhone status bar.")
        let wordCenter = word.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        wordCenter.press(forDuration: 0.8)
        screenshot("12-pdf-word-held")
        var copy = visibleTextMenuAction("Copy", timeout: 2)
        if copy == nil {
            // Tapping the selected text can reveal the iOS editing menu.
            wordCenter.tap()
            copy = visibleTextMenuAction("Copy")
        }
        let copyAction = try XCTUnwrap(copy, "The system text menu must offer Copy.")
        screenshot("12-native-pdf-selection")
        tap(copyAction, atCenter: true)
        reportCheckpoint("12-native-pdf-copy-tapped")

        tap(backToFiles, atCenter: true)
        tap(app.buttons["Back to Task"].firstMatch, atCenter: true)
        XCTAssertTrue(app.staticTexts["Original workspace PDF task"].firstMatch.waitForExistence(timeout: 10))
        let composer = app.webViews.textViews["Task message"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        tap(composer, atCenter: true)
        composer.press(forDuration: 0.8)
        let paste = try XCTUnwrap(visibleTextMenuAction("Paste"), "The system text menu must offer Paste.")
        tap(paste, atCenter: true)
        let allowPaste = app.alerts.buttons["Allow Paste"].firstMatch
        if allowPaste.waitForExistence(timeout: 2) { allowPaste.tap() }
        wait(composer, "value == 'Quartz'")
        XCTAssertEqual(composer.value as? String, "Quartz")
        screenshot("13-pdf-word-pasted")
    }

    func testConnectionPageInteractions() throws {
        screenshot("01-connection-page")
        tap(tab("Saved nodes"), atCenter: true, beforeConnectionInput: true)
        let savedNodesVisible = connectionPage.staticTexts["Connect a Joko node to begin."].firstMatch.waitForExistence(timeout: 10)
        if !savedNodesVisible { try? recordPreInputSetupFailure(launchArguments: ownedLaunchArguments) }
        XCTAssertTrue(savedNodesVisible, "The real Saved nodes tab did not activate.")
        screenshot("02-saved-nodes")
        tap(tab("Nearby"), atCenter: true)
        XCTAssertTrue(connectionPage.staticTexts["Nearby Joko nodes"].firstMatch.waitForExistence(timeout: 10))
        screenshot("03-nearby")
        tap(tab("Add Joko node"), atCenter: true)
        tap(connectionPage.buttons["Manual configuration"].firstMatch, atCenter: true)
        let address = connectionPage.textFields["Joko node address"].firstMatch
        let addressExists = address.waitForExistence(timeout: 10)
        if !addressExists { try? recordPreInputSetupFailure(launchArguments: ownedLaunchArguments, stage: "pre-input-address") }
        XCTAssertTrue(addressExists)
        guard addressExists else { return }
        let webRtc = connectionPage.switches["WebRTC"].firstMatch
        XCTAssertTrue(webRtc.waitForExistence(timeout: 10))
        if sdkRuntime == "http-connect-native" {
            wait(webRtc, "enabled == false")
            XCTAssertFalse(webRtc.isEnabled, "An unselected WebRTC runtime must remain unavailable.")
            screenshot("04-webrtc-unavailable")
        } else {
            tap(webRtc)
            wait(webRtc, "value == '1'")
            XCTAssertEqual(webRtc.value as? String, "1")
            screenshot("04-webrtc-mode")
        }
        let https = connectionPage.switches["HTTPS / WSS"].firstMatch
        tap(https)
        wait(https, "value == '1'")
        XCTAssertEqual(https.value as? String, "1")
        reportCheckpoint("04-https-selected")
        let inspect = button("Check node identity")
        replace(address, with: "not-an-address", traceFirstAddressEntry: true)
        reportCheckpoint("04-address-value-observed")
        wait(inspect, "enabled == false")
        XCTAssertTrue(button("Request pairing").exists)
        XCTAssertTrue(button("Pair this device").exists)
        XCTAssertFalse(button("Request pairing").isEnabled)
        XCTAssertFalse(button("Pair this device").isEnabled)
        screenshot("04-invalid-address")

        let port = try XCTUnwrap(ProcessInfo.processInfo.environment["JOKO_CI_PROBE_PORT"])
        let origin = "http://127.0.0.1:\(port)"
        replace(address, with: origin)
        wait(inspect, "enabled == true")
        tap(inspect)
        let error = connectionPage.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "CI local identity probe unavailable")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 15), "The real transport error must be visible.")
        wait(inspect, "enabled == true")
        screenshot("05-local-identity-error")

        // The second local request stays pending until its real Cancel action.
        tap(inspect)
        let cancel = button("Cancel")
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        try waitForPendingRequest(port)
        XCTAssertFalse(tab("Add Joko node").isEnabled)
        screenshot("06-inspection-pending")
        tap(cancel)
        wait(inspect, "enabled == true")
        wait(cancel, "exists == false")
        XCTAssertEqual(address.value as? String, origin)
        XCTAssertFalse(button("Request pairing").isEnabled)
        screenshot("07-cancelled-draft-retained")

        tap(tab("Saved nodes"), atCenter: true)
        XCTAssertFalse(address.exists, "Leaving Add must remove its active form.")
        tap(tab("Add Joko node"), atCenter: true)
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        XCTAssertEqual(address.value as? String, origin, "Mode changes must preserve the address draft.")
        screenshot("08-returned-address-draft")

        tap(button("Theme: Dark"))
        wait(button("Theme: Light"), "exists == true AND enabled == true")
        XCTAssertEqual(address.value as? String, origin, "Theme changes must preserve the address draft.")
        screenshot("09-dark-theme")
        tap(button("Theme: Light"))
        wait(button("Theme: Dark"), "exists == true AND enabled == true")
        XCTAssertEqual(address.value as? String, origin, "Theme changes must preserve the address draft.")
        screenshot("10-light-theme")
        if sdkRuntime == "http-connect-native" {
            // A fixed reserved-domain invitation verifies the delivered native
            // binding and configuration UI. Do not dispatch a proxy request.
            let invitation: [String: Any] = ["version": 1, "origin": "https://connect-node.example",
                "endpointPublicKey": "ed25519:" + String(repeating: "a", count: 64),
                "endpointTransport": ["kind": "http-connect", "proxyOrigin": "https://proxy.example", "authority": "connect-node.example:443"]]
            let text = String(data: try JSONSerialization.data(withJSONObject: invitation, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
            let trusted = connectionPage.textViews["Trusted node invitation or public key"].firstMatch
            XCTAssertTrue(trusted.waitForExistence(timeout: 10))
            replace(trusted, with: text, knownPublicInvitation: true)
            let helpText = "This invitation uses an HTTP CONNECT proxy. The node public key still verifies the encrypted application connection. Use a Desktop or Mobile build with its native connection binding."
            let help = connectionPage.staticTexts.matching(NSPredicate(format: "label == %@", helpText)).firstMatch
            XCTAssertTrue(help.waitForExistence(timeout: 10))
            wait(inspect, "enabled == true")
            XCTAssertEqual(address.value as? String, "https://connect-node.example")
            XCTAssertFalse(button("Create this device's iroh relay identity").exists)
            XCTAssertEqual(connectionPage.descendants(matching: .any).matching(identifier: "iroh connection mode").count, 0)
            let unavailableText = "This connection requires a native binding included in a Desktop or Mobile build. An ordinary browser cannot open this proxy connection."
            XCTAssertFalse(connectionPage.staticTexts.matching(NSPredicate(format: "label == %@", unavailableText)).firstMatch.exists)
            screenshot("11-http-connect-invitation")
        }
        if sdkRuntime == "relay", let pdf = try pdfFixtureInput("ci-pdf-fixture") {
            try copyOriginalWorkspacePdf(pdf)
        }
        XCTAssertEqual(app.state, .runningForeground)
    }
}
