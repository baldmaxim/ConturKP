"""Сценарии verify_discovery.py на синтетических материалах.

Полный PASS допустим только когда доступны все материалы. Реальные репозитории и архивы
не используются; нужен git в PATH.

Запуск из корня репозитория портала:
    python artifacts/stage-00/test_verify_discovery.py -v
"""

import dataclasses
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import zipfile

MODULE_PATH = pathlib.Path(__file__).with_name("verify_discovery.py")
SPEC = importlib.util.spec_from_file_location("verify_discovery", MODULE_PATH)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Fixture:
    """Git-репозиторий, архив API, образец RDWeb и документы с согласованными ссылками."""

    def __init__(self, root):
        self.root = root
        self.repo = root / "repo"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "src" / "a.txt").write_text("".join(f"line {n}\n" for n in range(1, 11)), encoding="utf-8")
        empty_config = root / "empty.gitconfig"
        empty_config.write_text("", encoding="utf-8")
        # Изолированная конфигурация git: результат не зависит от глобальных настроек машины.
        env = dict(
            os.environ,
            GIT_CONFIG_GLOBAL=str(empty_config),
            GIT_CONFIG_NOSYSTEM="1",
            GIT_AUTHOR_NAME="fixture",
            GIT_AUTHOR_EMAIL="fixture@example.invalid",
            GIT_COMMITTER_NAME="fixture",
            GIT_COMMITTER_EMAIL="fixture@example.invalid",
        )
        for command in (["init", "-q"], ["add", "."], ["commit", "-q", "-m", "fixture"]):
            subprocess.run(["git", "-C", str(self.repo), *command], check=True, capture_output=True, env=env)
        self.revision = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True, env=env
        ).stdout.strip()

        self.api_zip = root / "api.zip"
        with zipfile.ZipFile(self.api_zip, "w") as archive:
            archive.writestr("ApiTenderHub/README.md", "".join(f"doc {n}\n" for n in range(1, 21)))

        self.rdweb_zip = root / "rdweb.zip"
        blocks = {
            "schema_version": 1,
            "pages": [{"page_index": 0, "rotation": 0}, {"page_index": 1, "rotation": 90}],
            "blocks": [
                {"block_id": "b1", "block_type": "text"},
                {"block_id": "b2", "block_type": "image"},
                {"block_id": "b3", "block_type": "stamp"},
            ],
        }
        markdown = "# Document: x.pdf\n## Page 1\n### BLOCK #1 [TEXT]: b1\n## Page 2\n### BLOCK #2 [IMAGE]: b2\n"
        with zipfile.ZipFile(self.rdweb_zip, "w") as archive:
            archive.writestr("x_blocks.json", json.dumps(blocks))
            archive.writestr("x_results.md", markdown)

        self.portal = root / "portal"
        (self.portal / "docs").mkdir(parents=True)
        self.discovery = self.portal / "docs" / "discovery.md"
        self.discovery.write_text(
            "`LocalAI:src/a.txt:1-5` `MailHub:src/a.txt:3` `HUBTender:src/a.txt:2,10` `ApiTenderHub:README.md:20`\n"
            "| Q-01 | вопрос |\n\nСм. Q-01.\n",
            encoding="utf-8",
        )
        trace = "".join(f"| I{n:02d} |\n" for n in range(1, 20)) + " ".join(f"A{n:02d}" for n in range(1, 47))
        (self.portal / "docs" / "trace.md").write_text(trace + "\n", encoding="utf-8")

    def config(self, **changes):
        git = lambda alias: verify.Material(alias, "git", self.repo, self.revision)
        config = verify.Config(
            docs_root=self.portal,
            docs=["docs/discovery.md", "docs/trace.md"],
            trace_doc="docs/trace.md",
            discovery_doc="docs/discovery.md",
            materials={
                "LocalAI": git("LocalAI"),
                "MailHub": git("MailHub"),
                "HUBTender": git("HUBTender"),
                "ApiTenderHub": verify.Material("ApiTenderHub", "zip", self.api_zip, sha256(self.api_zip), "ApiTenderHub/"),
            },
            rdweb=verify.Material("RDWeb", "zip", self.rdweb_zip, sha256(self.rdweb_zip)),
            rdweb_expected={
                "schema_version": 1,
                "pages": 2,
                "rotation": {0: 1, 90: 1},
                "blocks": 3,
                "block_type": {"text": 1, "image": 1, "stamp": 1},
                "md_pages": 2,
                "md_blocks": 2,
                "json_only_types": {"stamp": 1},
            },
        )
        return dataclasses.replace(config, **changes)

    def config_with_material(self, alias, **changes):
        base = self.config()
        materials = dict(base.materials)
        materials[alias] = dataclasses.replace(materials[alias], **changes)
        return dataclasses.replace(base, materials=materials)


class VerifyDiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.fixture = Fixture(pathlib.Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def evaluate(self, config):
        results = verify.run(config)
        return verify.summarize(results, config.docs_only), results

    @staticmethod
    def statuses(results, prefix):
        return {result.status for result in results if result.name.startswith(prefix)}

    def test_all_materials_available_gives_full_pass(self):
        verdict, results = self.evaluate(self.fixture.config())
        self.assertEqual(verdict, ("PASS", 0), results)

    def test_missing_rdweb_is_blocked_not_pass(self):
        config = self.fixture.config(rdweb=dataclasses.replace(self.fixture.config().rdweb, path=self.fixture.root / "absent.zip"))
        verdict, results = self.evaluate(config)
        self.assertEqual(verdict, ("BLOCKED", 2), results)
        self.assertEqual(self.statuses(results, "образец RDWeb"), {"BLOCKED"})
        self.assertEqual(self.statuses(results, "ссылки LocalAI"), {"PASS"})

    def test_missing_api_zip_is_blocked_without_traceback(self):
        config = self.fixture.config_with_material("ApiTenderHub", path=self.fixture.root / "absent.zip")
        verdict, results = self.evaluate(config)
        self.assertEqual(verdict, ("BLOCKED", 2), results)
        self.assertEqual(self.statuses(results, "ссылки ApiTenderHub"), {"BLOCKED"})
        self.assertEqual(self.statuses(results, "образец RDWeb"), {"PASS"})

    def test_missing_git_revision_is_blocked(self):
        config = self.fixture.config_with_material("MailHub", expected="0" * 40)
        verdict, results = self.evaluate(config)
        self.assertEqual(verdict, ("BLOCKED", 2), results)
        self.assertEqual(self.statuses(results, "материал MailHub"), {"BLOCKED"})
        self.assertEqual(self.statuses(results, "ссылки MailHub"), {"BLOCKED"})

    def test_docs_only_mode_is_partial(self):
        verdict, results = self.evaluate(self.fixture.config(docs_only=True))
        self.assertEqual(verdict, ("PARTIAL", 3), results)
        self.assertIn("NOT_RUN", {result.status for result in results})
        self.assertNotIn("BLOCKED", {result.status for result in results})

    def test_changed_archive_fails(self):
        config = self.fixture.config(rdweb=dataclasses.replace(self.fixture.config().rdweb, expected="0" * 64))
        verdict, results = self.evaluate(config)
        self.assertEqual(verdict, ("FAIL", 1), results)

    def test_line_range_outside_file_fails(self):
        text = self.fixture.discovery.read_text(encoding="utf-8")
        self.fixture.discovery.write_text(text.replace("MailHub:src/a.txt:3", "MailHub:src/a.txt:99"), encoding="utf-8")
        verdict, results = self.evaluate(self.fixture.config())
        self.assertEqual(verdict, ("FAIL", 1), results)
        self.assertEqual(self.statuses(results, "ссылки MailHub"), {"FAIL"})

    def test_explicit_paths_override_workspace(self):
        manifest = self.fixture.root / "materials.json"
        manifest.write_text(json.dumps({"LocalAI": "repo", "ApiTenderHub": str(self.fixture.api_zip)}), encoding="utf-8")
        config = verify.build_config(
            ["--workspace", str(self.fixture.root / "nowhere"), "--materials", str(manifest), "--mailhub", str(self.fixture.repo)]
        )
        self.assertEqual(config.materials["LocalAI"].path, self.fixture.repo.resolve())
        self.assertEqual(config.materials["ApiTenderHub"].path, self.fixture.api_zip.resolve())
        self.assertEqual(config.materials["MailHub"].path, self.fixture.repo.resolve())
        self.assertEqual(config.materials["HUBTender"].path, (self.fixture.root / "nowhere" / "HUBTender").resolve())


if __name__ == "__main__":
    unittest.main()
