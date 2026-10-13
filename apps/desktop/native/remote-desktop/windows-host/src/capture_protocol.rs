//! Current v1 local broker framing. Capture always returns bounded JSON.
pub const OVERLAY_RESPONSE_LIMIT: usize = 1_750_000;
pub fn response_limit(init: &serde_json::Value) -> usize {
    if init["mode"] == "capture" { OVERLAY_RESPONSE_LIMIT } else { 32768 }
}
pub fn validate_init(init: &serde_json::Value, allow_authorize: bool) -> bool {
    let Some(object) = init.as_object() else { return false; };
    match init["mode"].as_str() {
        Some("probe" | "input") => object.len() == 1,
        Some("authorize") if allow_authorize => object.len() == 2
            && init["pid"].as_u64().is_some_and(|pid| pid > 0 && pid <= u32::MAX as u64),
        Some("capture") => object.len() == 4
            && init["cursorOverlay"].is_boolean()
            && init["bitrate"].as_u64().is_some_and(|rate| [0, 8_000_000, 20_000_000].contains(&rate))
            && init["rect"].as_array().is_some_and(|rect| rect.len() == 4
                && rect.iter().all(|value| value.as_i64().is_some_and(|number| i32::try_from(number).is_ok()))
                && rect[0].as_i64().unwrap().unsigned_abs() <= 65536
                && rect[1].as_i64().unwrap().unsigned_abs() <= 65536
                && (1..=16384).contains(&rect[2].as_i64().unwrap())
                && (1..=16384).contains(&rect[3].as_i64().unwrap())),
        _ => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn current_init_has_exact_fields_and_bounded_monitor_geometry() {
        assert!(validate_init(&json!({"mode":"input"}), false));
        assert!(validate_init(&json!({"mode":"probe"}), false));
        assert!(validate_init(&json!({"mode":"authorize","pid":1}), true));
        assert!(!validate_init(&json!({"mode":"authorize","pid":1}), false));
        let valid = json!({"mode":"capture","rect":[-1920,0,1920,1080],"cursorOverlay":false,"bitrate":8_000_000});
        assert!(validate_init(&valid, false));
        assert_eq!(response_limit(&valid), OVERLAY_RESPONSE_LIMIT);
        assert!(validate_init(&json!({"mode":"capture","rect":[0,0,1920,1080],"cursorOverlay":true,"bitrate":0}), false));
        for invalid in [
            json!({"mode":"input","extra":true}),
            json!({"mode":"capture","rect":[0,0,1920,1080],"bitrate":8_000_000}),
            json!({"mode":"capture","rect":[0,0,0,1080],"cursorOverlay":true,"bitrate":8_000_000}),
            json!({"mode":"capture","rect":[65537,0,1920,1080],"cursorOverlay":true,"bitrate":8_000_000}),
            json!({"mode":"capture","rect":[0,0,1920,1080],"cursorOverlay":"true","bitrate":8_000_000}),
            json!({"mode":"capture","rect":[0,0,1920,1080],"cursorOverlay":true,"bitrate":3_000_000}),
        ] { assert!(!validate_init(&invalid, false)); }
    }
}
