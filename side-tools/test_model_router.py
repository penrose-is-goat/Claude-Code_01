from __future__ import annotations

import json
import unittest
from unittest.mock import patch

import model_router


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class ModelRouterTests(unittest.TestCase):
    def setUp(self):
        model_router._STATUS_CACHE = None

    def test_status_requires_configured_model_to_be_installed(self):
        payload = {"models": [{"name": "qwen3.5:9b"}]}
        with patch("model_router.urllib.request.urlopen", return_value=FakeResponse(payload)):
            status = model_router.ollama_status(force=True)
        self.assertTrue(status["ready"])
        self.assertEqual(status["model"], "qwen3.5:9b")

    def test_fed_model_intent_cannot_select_unknown_meeting(self):
        with patch.object(
            model_router,
            "generate_json",
            return_value=(
                {"view": "historical", "meetingDate": "2099-01-01", "historyRange": "ALL"},
                "qwen3.5:9b",
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "outside the available calendar"):
                model_router.fed_intent("unknown wording", ["2026-09-16"])

    def test_fed_model_does_not_invent_an_unrequested_history_range(self):
        with patch.object(
            model_router,
            "generate_json",
            return_value=(
                {"view": "historical", "meetingDate": "2026-09-16", "historyRange": "ALL"},
                "qwen3.5:9b",
            ),
        ):
            spec, _ = model_router.fed_intent(
                "Take me to the time-machine view for the first listed meeting",
                ["2026-09-16"],
            )
        self.assertEqual(spec["historyRange"], "1Y")


if __name__ == "__main__":
    unittest.main()
