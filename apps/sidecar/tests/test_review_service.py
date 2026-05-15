import unittest

from app.services.review_service import _acceptable_readings_for_ref, _sentence_order_matches


class ReviewServiceTest(unittest.TestCase):
    def test_sentence_order_allows_swapped_identical_surfaces(self):
        question = {
            "pieces": [
                {"id": "p0", "surface": "また"},
                {"id": "p1", "surface": "また"},
                {"id": "p2", "surface": "来る"},
            ],
            "correct_order_ids": ["p0", "p1", "p2"],
        }

        self.assertTrue(_sentence_order_matches(["p1", "p0", "p2"], question))
        self.assertFalse(_sentence_order_matches(["p2", "p0", "p1"], question))

    def test_reading_accepts_suru_dictionary_variant_for_masu_surface(self):
        variants = _acceptable_readings_for_ref(
            {
                "surface": "紹介します",
                "dictionary_form": "紹介する",
                "reading": "ショウカイシマス",
            }
        )

        self.assertIn("しょうかいします", variants)
        self.assertIn("しょうかいする", variants)


if __name__ == "__main__":
    unittest.main()
