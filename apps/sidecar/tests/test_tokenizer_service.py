import unittest
from unittest.mock import patch

from app.services import tokenizer_service


class FakeMorpheme:
    def __init__(self, surface, dictionary_form, reading, pos):
        self._surface = surface
        self._dictionary_form = dictionary_form
        self._reading = reading
        self._pos = pos

    def surface(self):
        return self._surface

    def dictionary_form(self):
        return self._dictionary_form

    def reading_form(self):
        return self._reading

    def part_of_speech(self):
        return self._pos


class FakeTokenizer:
    def tokenize(self, text):
        if text == "しました":
            return [
                FakeMorpheme("し", "する", "シ", ("動詞", "非自立可能", "*", "*", "*", "*")),
                FakeMorpheme("まし", "ます", "マシ", ("助動詞", "*", "*", "*", "*", "*")),
                FakeMorpheme("た", "た", "タ", ("助動詞", "*", "*", "*", "*", "*")),
            ]
        return []


class TokenizerServiceTest(unittest.TestCase):
    def test_normalize_ocr_small_tsu_only_in_conservative_contexts(self):
        self.assertEqual(tokenizer_service.normalize_ocr_small_tsu("待つて 行つた こつち"), "待って 行った こっち")
        self.assertEqual(tokenizer_service.normalize_ocr_small_tsu("いつか いつも"), "いつか いつも")

    def test_tokenize_keeps_shimashita_as_verb_chain(self):
        with patch.object(tokenizer_service, "get_tokenizer", return_value=FakeTokenizer()):
            tokens = tokenizer_service.tokenize_ja("しました")

        self.assertEqual(len(tokens), 1)
        self.assertEqual(tokens[0]["surface"], "しました")
        self.assertEqual(tokens[0]["dictionary_form"], "する")
        self.assertEqual(tokens[0]["pos"], "动词")
        self.assertNotIn("_raw_pos", tokens[0])


if __name__ == "__main__":
    unittest.main()
