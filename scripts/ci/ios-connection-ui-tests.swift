import Foundation
import XCTest

// Real accessibility interactions with the shipped connection WebView. No
// injected JavaScript, mocked controls, external node or account is involved.
final class JokoConnectionUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard let metro = environment["JOKO_CI_METRO_PORT"], Int(metro) != nil,
              let probe = environment["JOKO_CI_PROBE_PORT"], Int(probe) != nil else {
            throw NSError(domain: "JokoCI", code: 1, userInfo: [NSLocalizedDescriptionKey: "Owned local servers were not passed to the UI runner."])
        }
        app = XCUIApplication(bundleIdentifier: "app.joko.mobile")
        app.launchArguments = ["-RCT_jsLocation", "127.0.0.1:\(metro)", "-RCT_packager_scheme", "http", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(app.buttons["Nearby"].firstMatch.waitForExistence(timeout: 45))
        XCTAssertEqual(app.webViews.count, 1, "The real connection page must be present.")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func wait(_ element: XCUIElement, _ predicate: String, timeout: TimeInterval = 10) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed)
    }

    private func button(_ label: String) -> XCUIElement { app.buttons[label].firstMatch }

    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 10))
        // WKWebView's page can scroll while the native keyboard is open. Scroll
        // the actual page to expose the control rather than tapping coordinates.
        for _ in 0..<4 {
            if element.isHittable { break }
            app.webViews.firstMatch.swipeUp()
        }
        for _ in 0..<5 {
            if element.isHittable { break }
            app.webViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }

    private func replace(_ field: XCUIElement, with text: String) {
        tap(field)
        let current = field.value as? String ?? ""
        if !current.isEmpty { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        field.typeText(text)
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 10), .completed)
        // The URL keyboard's real Done accessory dismisses it. On a layout
        // without that accessory, tapping the form heading blurs the field.
        let done = app.buttons["Done"].firstMatch
        if done.exists && done.isHittable { done.tap() }
        else {
            let heading = app.staticTexts["Pair this device"].firstMatch
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
        tap(button("Saved nodes"))
        XCTAssertTrue(app.staticTexts["Connect a Joko node to begin."].firstMatch.waitForExistence(timeout: 10))
        screenshot("02-saved-nodes")
        tap(button("Nearby"))
        XCTAssertTrue(app.staticTexts["Nearby Joko nodes"].firstMatch.waitForExistence(timeout: 10))
        screenshot("03-nearby")
        tap(button("Add Joko node"))
        let address = app.textFields["Joko node address"].firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 10))
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
        let error = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "CI local identity probe unavailable")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: 15), "The real transport error must be visible.")
        wait(inspect, "enabled == true")
        screenshot("05-local-identity-error")

        // The second local request stays pending until its real Cancel action.
        tap(inspect)
        let cancel = button("Cancel")
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        try waitForPendingRequest(port)
        XCTAssertFalse(button("Add Joko node").isEnabled)
        screenshot("06-inspection-pending")
        tap(cancel)
        wait(inspect, "enabled == true")
        wait(cancel, "exists == false")
        XCTAssertEqual(address.value as? String, origin)
        XCTAssertFalse(button("Request pairing").isEnabled)
        screenshot("07-cancelled-draft-retained")

        tap(button("Saved nodes"))
        XCTAssertFalse(address.exists, "Leaving Add must remove its active form.")
        tap(button("Add Joko node"))
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
