import Foundation
import XCTest

// Real accessibility interactions with the shipped connection WebView. No
// injected JavaScript, mocked controls, external node or account is involved.
final class JokoConnectionUITests: XCTestCase {
    private var app: XCUIApplication!
    private var ownedLaunchArguments: [String] = []

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
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
        app.activate()
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
        screenshot("\(prefix)-screen")
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

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
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

    private func tap(_ element: XCUIElement, atCenter: Bool = false) {
        // Debug builds can present native LogBox toasts over WKWebView controls.
        // Close those exact development surfaces through their real UI; keep
        // application errors, dialogs, and every connection assertion visible.
        for prefix in ["Open debugger to view warnings.", "[expo-notifications] Error reading persisted"] {
            // This native LogBox version exposes the combined icon and message
            // as Other, with the exact observed "!, " label prefix.
            let notice = app.descendants(matching: .any).matching(NSPredicate(
                format: "label BEGINSWITH %@ OR label BEGINSWITH %@", prefix, "!, \(prefix)")).firstMatch
            if notice.exists && notice.isHittable {
                // The installed notification groups its unlabeled close icon
                // into this full-width accessibility element. Its real layout
                // is 12 points of right padding plus a 20-point close button.
                // Tapping the message itself opens external developer tools.
                XCTAssertGreaterThan(notice.frame.width, 44)
                notice.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5))
                    .withOffset(CGVector(dx: -22, dy: 0)).tap()
                wait(notice, "exists == false", timeout: 5)
            }
        }
        XCTAssertTrue(element.waitForExistence(timeout: 10))
        // WKWebView's page can scroll while the native keyboard is open. Scroll
        // the actual page to expose the control rather than tapping coordinates.
        for _ in 0..<4 {
            if element.isHittable { break }
            connectionPage.swipeUp()
        }
        for _ in 0..<5 {
            if element.isHittable { break }
            connectionPage.swipeDown()
        }
        XCTAssertTrue(element.isHittable)
        if atCenter {
            // WebView tabs are exposed as switches. Hit the exact labeled tab's
            // measured center instead of using a native switch's chosen point.
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        } else {
            element.tap()
        }
    }

    private func replace(_ field: XCUIElement, with text: String) {
        tap(field)
        // A real field tap can place the caret before existing text. Select the
        // complete value through the native keyboard before replacing it.
        field.typeKey("a", modifierFlags: .command)
        field.typeText(text)
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 10), .completed)
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
            let complete = expectation(description: "Read only the local probe request count")
            var pending = false
            var request = URLRequest(url: endpoint)
            request.timeoutInterval = 1
            URLSession.shared.dataTask(with: request) { data, _, _ in
                if let data = data, let status = try? JSONSerialization.jsonObject(with: data) as? [String: Int] {
                    pending = status["identityRequests"] == 2
                }
                complete.fulfill()
            }.resume()
            wait(for: [complete], timeout: 2)
            if pending { return }
            Thread.sleep(forTimeInterval: 0.2)
        }
        XCTFail("The second native identity request did not reach the owned local server.")
    }

    func testConnectionPageInteractions() throws {
        screenshot("01-connection-page")
        tap(tab("Saved nodes"), atCenter: true)
        let savedNodesVisible = connectionPage.staticTexts["Connect a Joko node to begin."].firstMatch.waitForExistence(timeout: 10)
        if !savedNodesVisible { try? recordPreInputSetupFailure(launchArguments: ownedLaunchArguments) }
        XCTAssertTrue(savedNodesVisible, "The real Saved nodes tab did not activate.")
        screenshot("02-saved-nodes")
        tap(tab("Nearby"), atCenter: true)
        XCTAssertTrue(connectionPage.staticTexts["Nearby Joko nodes"].firstMatch.waitForExistence(timeout: 10))
        screenshot("03-nearby")
        tap(tab("Add Joko node"), atCenter: true)
        let address = connectionPage.textFields["Joko node address"].firstMatch
        let addressExists = address.waitForExistence(timeout: 10)
        if !addressExists { try? recordPreInputSetupFailure(launchArguments: ownedLaunchArguments, stage: "pre-input-address") }
        XCTAssertTrue(addressExists)
        guard addressExists else { return }
        let inspect = button("Check node identity")
        replace(address, with: "not-an-address")
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
        XCTAssertTrue(button("Theme: Light").waitForExistence(timeout: 10))
        screenshot("09-dark-theme")
        tap(button("Theme: Light"))
        XCTAssertTrue(button("Theme: Dark").waitForExistence(timeout: 10))
        screenshot("10-light-theme")
        XCTAssertEqual(app.state, .runningForeground)
    }
}
