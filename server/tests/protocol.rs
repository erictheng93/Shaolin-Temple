use temple_server::protocol::{
    ActionFrame, BatchKind, ClientMessage, MAX_MESSAGE_BYTES, MoveTuple, Moving, PROTOCOL_VERSION,
    ServerMessage, decode_action, decode_batch, encode_action, encode_batch, unwrap_started_at,
};
use temple_server::world;
#[test]
fn shared_frontend_fixtures_round_trip() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("protocol-v3.json")).unwrap();
    for value in fixtures["server"].as_array().unwrap() {
        let message: ServerMessage = serde_json::from_value(value.clone()).unwrap();
        let actual = serde_json::to_value(message).unwrap();
        // JSON numeric representations such as 0 and 0.0 are equivalent in JavaScript.
        assert_eq!(normalize(actual), normalize(value.clone()));
    }
    let hello = fixtures["client"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["t"] == "hello");
    assert_eq!(hello.unwrap()["v"].as_f64(), Some(PROTOCOL_VERSION));
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
        r#"{"t":"chat"}"#,
        r#"{"t":"chat","text":5}"#,
    ] {
        assert!(serde_json::from_str::<ClientMessage>(raw).is_err());
    }
    assert!(serde_json::from_str::<ServerMessage>(r#"{"t":"moves","m":[["a",0,0,0,2]]}"#).is_err());
}

fn fixtures() -> serde_json::Value {
    serde_json::from_str(include_str!("protocol-v3.json")).unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn batch(value: &serde_json::Value) -> (BatchKind, Vec<MoveTuple>) {
    let kind = match value["t"].as_str().unwrap() {
        "moves" => BatchKind::Moves,
        "sync" => BatchKind::Sync,
        other => panic!("unexpected kind {other}"),
    };
    let m = value["m"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let moving = match t[4].as_u64().unwrap() {
                0 => Moving::Stopped,
                _ => Moving::Moving,
            };
            let f = |i: usize| t[i].as_f64().unwrap();
            (t[0].as_u64().unwrap() as u8, f(1), f(2), f(3), moving)
        })
        .collect();
    (kind, m)
}

/// 前後端共用的二進位測試向量：伺服器編碼結果與 hex 完全相同，解碼結果與 decoded 一致。
#[test]
fn shared_binary_vectors_encode_and_decode() {
    let fixtures = fixtures();
    let valid = fixtures["binary"]["valid"].as_array().unwrap();
    assert!(valid.len() >= 6);
    for case in valid {
        let name = case["name"].as_str().unwrap();
        let bytes = hex(case["hex"].as_str().unwrap());
        let (kind, input) = batch(&case["input"]);
        assert_eq!(
            encode_batch(kind, &input).as_deref(),
            Some(&bytes[..]),
            "{name}"
        );
        let (expected_kind, expected) = batch(&case["decoded"]);
        let (got_kind, got) = decode_batch(&bytes).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(got_kind, expected_kind, "{name}");
        assert_eq!(got.len(), expected.len(), "{name}");
        for (a, b) in got.iter().zip(&expected) {
            assert_eq!((a.0, a.4), (b.0, b.4), "{name}");
            // serde_json 解析小數不保證最接近的 f64，容許 1e-12 的差距。
            for (x, y) in [(a.1, b.1), (a.2, b.2), (a.3, b.3)] {
                assert!((x - y).abs() < 1e-12, "{name}: {x} vs {y}");
            }
        }
        // 解出來的值再編碼一次得到同一個幀（量化是冪等的）。
        assert_eq!(encode_batch(got_kind, &got), Some(bytes), "{name}");
    }
    for case in fixtures["binary"]["invalid"].as_array().unwrap() {
        let bytes = hex(case["hex"].as_str().unwrap());
        assert!(decode_batch(&bytes).is_err(), "{}", case["name"]);
    }
}

#[test]
fn batch_encoding_refuses_what_the_frame_cannot_carry() {
    let entry = (0u8, 0.0, 0.0, 0.0, Moving::Stopped);
    assert!(encode_batch(BatchKind::Moves, &[entry; 200]).is_some());
    assert!(encode_batch(BatchKind::Moves, &[entry; 201]).is_none());
    assert!(encode_batch(BatchKind::Sync, &[(128, 0.0, 0.0, 0.0, Moving::Moving)]).is_none());
    // 最大的幀遠小於單則訊息上限。
    assert!(encode_batch(BatchKind::Sync, &[entry; 200]).unwrap().len() <= MAX_MESSAGE_BYTES);
    // moves／sync 不再以 JSON 送出。
    let moves = ServerMessage::Moves { m: vec![entry] };
    assert!(serde_json::to_string(&moves).is_err());
}

/// 動作編號對照表就是 `world::ACTIONS`（同一順序），與前端 `ACTION_CODES` 共用固定資料。
#[test]
fn action_codes_match_shared_fixture() {
    let fixtures = fixtures();
    let codes: Vec<&str> = fixtures["binary"]["action"]["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap())
        .collect();
    assert_eq!(codes, world::ACTIONS);
    for (i, id) in world::ACTIONS.iter().enumerate() {
        assert_eq!(world::action_code(id), Some(i as u8));
    }
    assert_eq!(world::action_code("dance"), None);
}

#[test]
fn shared_action_vectors_encode_decode_and_unwrap() {
    let fixtures = fixtures();
    let action = &fixtures["binary"]["action"];
    let valid = action["valid"].as_array().unwrap();
    assert_eq!(valid.len(), world::ACTIONS.len());
    for case in valid {
        let name = case["name"].as_str().unwrap();
        let bytes = hex(case["hex"].as_str().unwrap());
        let input = &case["input"];
        let n = input["n"].as_u64().unwrap() as u8;
        let id = input["id"].as_str().unwrap();
        let started_at = input["startedAt"].as_f64().unwrap();
        let code = world::action_code(id).unwrap();
        assert_eq!(
            encode_action(n, code, started_at).as_deref(),
            Some(&bytes[..]),
            "{name}"
        );
        // 伺服器實際送出的路徑（ServerMessage::to_frame）也是同一個幀。
        let message = ServerMessage::Action {
            n,
            code,
            started_at,
        };
        assert_eq!(
            message.to_frame(),
            Some(temple_server::protocol::Frame::Binary(bytes.clone())),
            "{name}"
        );
        let decoded = &case["decoded"];
        assert_eq!(
            decode_action(&bytes),
            Ok(ActionFrame {
                n: decoded["n"].as_u64().unwrap() as u8,
                id: world::action(decoded["id"].as_str().unwrap()).unwrap(),
                started_at_low: decoded["startedAtLow"].as_u64().unwrap() as u32,
            }),
            "{name}"
        );
    }
    let invalid = action["invalid"].as_array().unwrap();
    assert!(invalid.len() >= 6);
    for case in invalid {
        let bytes = hex(case["hex"].as_str().unwrap());
        assert!(decode_action(&bytes).is_err(), "{}", case["name"]);
        // 也不會被當成 moves／sync。
        assert!(decode_batch(&bytes).is_err(), "{}", case["name"]);
    }
    let unwrap = action["unwrap"].as_array().unwrap();
    assert!(unwrap.len() >= 8);
    for case in unwrap {
        let low = case["low"].as_u64().unwrap() as u32;
        let reference = case["reference"].as_f64().unwrap();
        assert_eq!(
            unwrap_started_at(low, reference),
            case["startedAt"].as_f64().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn action_encoding_refuses_what_the_frame_cannot_carry() {
    assert!(encode_action(127, 0, 0.0).is_some());
    assert!(encode_action(128, 0, 0.0).is_none());
    assert!(encode_action(0, world::ACTIONS.len() as u8, 0.0).is_none());
    assert!(encode_action(0, 0, -1.0).is_none());
    assert!(encode_action(0, 0, f64::NAN).is_none());
    // action 不再以 JSON 送出。
    let message = ServerMessage::Action {
        n: 0,
        code: 0,
        started_at: 0.0,
    };
    assert!(serde_json::to_string(&message).is_err());
}
