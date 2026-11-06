use temple_server::protocol::{ClientMessage, ServerMessage};
#[test]
fn shared_frontend_fixtures_round_trip() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("protocol-v1.json")).unwrap();
    for value in fixtures["server"].as_array().unwrap() {
        let message: ServerMessage = serde_json::from_value(value.clone()).unwrap();
        let actual = serde_json::to_value(message).unwrap();
        // JSON numeric representations such as 0 and 0.0 are equivalent in JavaScript.
        assert_eq!(normalize(actual), normalize(value.clone()));
    }
    for value in fixtures["client"].as_array().unwrap() {
        let message: ClientMessage = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            normalize(serde_json::to_value(message).unwrap()),
            normalize(value.clone())
        );
    }
}
fn normalize(value: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(normalize).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, normalize(v))).collect()),
        other => other,
    }
}
#[test]
fn malformed_client_fields_rejected() {
    for raw in [
        r#"{"t":"move","x":"x","z":0,"heading":0,"seq":1}"#,
        r#"{"t":"ping","ts":1e999}"#,
        r#"{"t":"action","reqId":"r","id":"bow","data":[]}"#,
        r#"{"t":"unknown"}"#,
    ] {
        assert!(serde_json::from_str::<ClientMessage>(raw).is_err());
    }
    assert!(serde_json::from_str::<ServerMessage>(r#"{"t":"moves","m":[["a",0,0,0,2]]}"#).is_err());
}
