from __future__ import annotations

import unittest

from dsh_viztools.privacy import safe_tool_arguments, safe_tool_rows


class PrivacyProjectionTest(unittest.TestCase):
    def test_unknown_tool_omits_raw_arguments(self) -> None:
        value = safe_tool_arguments("bash", {"command": "curl https://x/?access_token=SUPERSECRET"})
        self.assertIn("OMITTED arguments", value)
        self.assertNotIn("SUPERSECRET", value)

    def test_safe_fields_redact_secret_keys_and_token_urls(self) -> None:
        value = safe_tool_arguments("read", {
            "file_path": "https://host/file?access_token=SUPERSECRET",
            "offset": 1,
            "password": "SUPERSECRET",
        })
        self.assertNotIn("password", value)
        self.assertNotIn("SUPERSECRET", str(value))
        self.assertIn("[REDACTED]", value["file_path"])

    def test_large_values_become_hash_and_size_placeholder(self) -> None:
        value = safe_tool_arguments("read", {"file_path": "x" * 1000}, max_string=64)
        self.assertIn("OMITTED string", value["file_path"])
        self.assertIn("sha256:", value["file_path"])

    def test_rows_exclude_call_identity_and_raw_arguments(self) -> None:
        rows = safe_tool_rows([{
            "call_id": "secret-call", "tool_name": "bash", "arguments": "TOPSECRET", "duration_ms": 1,
            "is_error": False, "error_code": None,
        }])
        self.assertNotIn("call_id", rows[0])
        self.assertNotIn("TOPSECRET", str(rows))


if __name__ == "__main__":
    unittest.main()
