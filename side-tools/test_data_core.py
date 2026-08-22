from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import data_core


class BinaryTransportTests(unittest.TestCase):
    def test_binary_response_is_cached_without_text_decoding(self):
        payload = b"PK\x03\x04\x00\xffbinary-workbook"
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(data_core, "CACHE_DIR", Path(directory)),
                patch.object(data_core, "_urllib_get_bytes", return_value=payload) as loader,
                patch.object(data_core, "_curl_get_bytes") as curl,
            ):
                first = data_core.http_get_bytes("https://example.test/data.xlsx", cache_ttl=60)
                second = data_core.http_get_bytes("https://example.test/data.xlsx", cache_ttl=60)
        self.assertEqual(first.content, payload)
        self.assertEqual(second.content, payload)
        self.assertFalse(first.from_cache)
        self.assertTrue(second.from_cache)
        loader.assert_called_once()
        curl.assert_not_called()

    def test_binary_transport_uses_second_loader_after_first_fails(self):
        payload = b"fallback-binary"
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(data_core, "CACHE_DIR", Path(directory)),
                patch.object(data_core, "_urllib_get_bytes", side_effect=RuntimeError("blocked")),
                patch.object(data_core, "_curl_get_bytes", return_value=payload),
            ):
                result = data_core.http_get_bytes("https://example.test/data.xlsx")
        self.assertEqual(result.content, payload)
        self.assertEqual(result.transport, "curl")


if __name__ == "__main__":
    unittest.main()
