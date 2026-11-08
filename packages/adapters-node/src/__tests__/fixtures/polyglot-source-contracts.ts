// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const scalarSourceContractFixtures = [
  { languageId: "python", sourcePath: "provider.py", testPath: "checks.py", files: {
    "provider.py": "# Add one to each supplied numeric input.\ndef f0(value):\n    return value + 1\n",
    "checks.py": "from provider import f0 as g0\ndef test_values():\n    assert g0(1) == 2\n    assert g0(2) == 3\n    assert g0(5) == 6\n"
  } },
  { languageId: "go", sourcePath: "provider.go", testPath: "provider_test.go", files: {
    "go.mod": "module example.org/opaque\n\ngo 1.20\n",
    "provider.go": "package opaque\n// Add one to each supplied numeric input.\nfunc f0(value int) int { return value + 1 }\n",
    "provider_test.go": "package opaque\nimport \"testing\"\nfunc TestValues(t *testing.T) {\n if f0(1) != 2 { t.Fatal(\"case\") }\n if f0(2) != 3 { t.Fatal(\"case\") }\n if f0(5) != 6 { t.Fatal(\"case\") }\n}\n"
  } },
  { languageId: "rust", sourcePath: "lib.rs", testPath: "lib.rs", files: {
    "lib.rs": "// Add one to each supplied numeric input.\npub fn f0(value: f64) -> f64 { value + 1.0 }\n#[cfg(test)]\nmod checks {\n use super::f0;\n #[test]\n fn values() {\n  assert_eq!(f0(1.0), 2.0);\n  assert_eq!(f0(2.0), 3.0);\n  assert_eq!(f0(5.0), 6.0);\n }\n}\n"
  } }
] as const;

export const statefulSourceContractFixtures = [
  { languageId: "python", sourcePath: "provider.py", testPath: "checks.py", files: {
    "provider.py": "# Keep public key values across ordered invocations.\n_state = {}\ndef f0(key, value):\n    _state[key] = value\ndef f1(key):\n    return _state[key]\n",
    "checks.py": "from provider import f0 as g0, f1 as g1\ndef public_sequence():\n    g0('a', 111)\n    assert g1('a') == 111\n    g0('a', 222)\n    assert g1('a') == 222\n"
  } },
  { languageId: "go", sourcePath: "provider.go", testPath: "provider_test.go", files: {
    "go.mod": "module example.org/opaque\n\ngo 1.20\n",
    "provider.go": "package opaque\n// Keep public key values across ordered invocations.\nvar state = map[string]int{}\nfunc f0(key string, value int) { state[key] = value }\nfunc f1(key string) int { return state[key] }\n",
    "provider_test.go": "package opaque\nimport \"testing\"\nfunc TestSequence(t *testing.T) {\n f0(\"a\", 111)\n if f1(\"a\") != 111 { t.Fatal(\"case\") }\n f0(\"a\", 222)\n if f1(\"a\") != 222 { t.Fatal(\"case\") }\n}\n"
  } },
  { languageId: "rust", sourcePath: "lib.rs", testPath: "lib.rs", files: {
    "lib.rs": "// Keep public key values across ordered invocations.\nuse std::sync::{Mutex, OnceLock};\nuse std::collections::HashMap;\nstatic STATE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();\npub fn f0(key: &str, value: i64) { STATE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap().insert(key.to_string(), value); }\npub fn f1(key: &str) -> i64 { *STATE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap().get(key).unwrap() }\n#[cfg(test)]\nmod checks {\n use super::f0;\n use super::f1;\n #[test]\n fn values() {\n  f0(\"a\", 111);\n  assert_eq!(f1(\"a\"), 111);\n  f0(\"a\", 222);\n  assert_eq!(f1(\"a\"), 222);\n }\n}\n"
  } }
] as const;
