"""Сценарии verify_architecture.py.

Проверяется, что скрипт находит рассогласование документов, а не только подтверждает успех.
Для отрицательных сценариев каталог `docs/` копируется во временную папку и портится.

Запуск из корня репозитория портала:
    python artifacts/stage-01/test_verify_architecture.py -v
"""

import importlib.util
import pathlib
import shutil
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("verify_architecture.py")
SPEC = importlib.util.spec_from_file_location("verify_architecture", MODULE_PATH)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)

REPO_ROOT = MODULE_PATH.resolve().parents[2]


class VerifyArchitectureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = pathlib.Path(self.tmp.name) / "repo"
        shutil.copytree(REPO_ROOT / "docs", self.root / "docs")

    def tearDown(self):
        self.tmp.cleanup()

    def verdict(self, root=None):
        results = verify.run(root or self.root)
        return verify.summarize(results), results

    def patch(self, rel, old, new, count=1):
        """count=-1 заменяет все вхождения: имя сущности встречается в нескольких разделах."""
        path = self.root / rel
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"фрагмент не найден в {rel}")
        path.write_text(text.replace(old, new, count), encoding="utf-8")

    def failed_names(self, results):
        return [result.name for result in results if result.status == verify.FAIL]

    def test_repository_passes(self):
        verdict, results = self.verdict(REPO_ROOT)
        self.assertEqual(verdict, ("PASS", 0), self.failed_names(results))

    def test_copy_passes(self):
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("PASS", 0), self.failed_names(results))

    def test_missing_adr_section_fails(self):
        self.patch("docs/adr/ADR-001-stack-and-processes.md", "## Альтернативы", "## Прочее")
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertTrue(any("ADR-001" in name for name in self.failed_names(results)))

    def test_missing_invariant_row_fails(self):
        self.patch("docs/architecture/invariants.md", "| I05 |", "| I05-x |")
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertIn("инварианты I01–I19 с механизмом и проверкой", self.failed_names(results))

    def test_missing_case_fails(self):
        self.patch("docs/architecture/test-plan.md", "| A33 |", "| A33x |")
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertIn("сценарии A01–A46 в плане тестирования", self.failed_names(results))

    def test_missing_entity_fails(self):
        self.patch("docs/architecture/data-model.md", "`send_event`", "`send_evt`", count=-1)
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertTrue(any("сущности спецификации" in name for name in self.failed_names(results)))

    def test_undefined_unknown_id_fails(self):
        self.patch("docs/architecture/overview.md", "## 1. Контекст", "## 1. Контекст\n\nСм. Q-99.")
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertTrue(any("ID Q/U/X/R определены" in name for name in self.failed_names(results)))

    def test_core_isolation_fails(self):
        self.patch("docs/architecture/unknowns.md", "| адаптер | 04 |", "| ядро | 04 |")
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertIn("ни одно неизвестное не требует переделки ядра", self.failed_names(results))

    def test_broken_link_fails(self):
        self.patch("docs/architecture/overview.md", "## 1. Контекст", "## 1. Контекст\n\n[нет файла](nowhere.md)")
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertIn("относительные ссылки ведут на существующие файлы", self.failed_names(results))

    def test_empty_traceability_cell_fails(self):
        self.patch(
            "docs/requirements-traceability.md",
            "| I19 | Неизменяемость защищает от действий приложения, но не абсолютна | 13, 17 | ADR-002 §3 |",
            "| I19 | Неизменяемость защищает от действий приложения, но не абсолютна | 13, 17 | — |",
        )
        verdict, results = self.verdict()
        self.assertEqual(verdict, ("FAIL", 1))
        self.assertTrue(any("Реализация" in name for name in self.failed_names(results)))


if __name__ == "__main__":
    unittest.main()
