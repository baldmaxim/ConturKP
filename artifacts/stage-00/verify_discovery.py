"""Проверки документов этапа 00.

1. Ссылки `Система:путь:строки` существуют в зафиксированных ревизиях.
   Проверяется наличие диапазона строк, а не истинность утверждения на них.
2. Все I01–I19 и A01–A46 есть в трассировке требований.
3. Все упомянутые X-/Q-/U-/R- определены в discovery.
4. Документы — валидный UTF-8 без строк, похожих на секреты. Шаблоны не исчерпывающие.
5. Счётчики образца RDWeb совпадают с discovery §7.1.

Итог и код выхода:
    PASS     0  все проверки выполнены и пройдены;
    FAIL     1  хотя бы одна проверка не пройдена;
    BLOCKED  2  ошибок нет, но часть материалов или ревизий недоступна;
    PARTIAL  3  явно выбран --docs-only, проверки материалов не выполнялись.

Запуск из корня репозитория портала (только чтение):
    python artifacts/stage-00/verify_discovery.py
    python artifacts/stage-00/verify_discovery.py --localai D:/src/LocalAI --api-zip D:/in/ApiTenderHub.zip
    python artifacts/stage-00/verify_discovery.py --materials materials.json
    python artifacts/stage-00/verify_discovery.py --docs-only

Manifest --materials — JSON вида {"LocalAI": "путь", "MailHub": "...", "HUBTender": "...",
"ApiTenderHub": "...", "RDWeb": "..."}; относительные пути считаются от файла manifest.
Приоритет: флаг, затем manifest, затем путь по умолчанию относительно --workspace.
"""

import argparse
import collections
import dataclasses
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile

PASS, FAIL, BLOCKED, NOT_RUN = "PASS", "FAIL", "BLOCKED", "NOT_RUN"

# Материалы: вид, путь по умолчанию относительно --workspace, ревизия или SHA-256, префикс в архиве.
DEFAULT_MATERIALS = {
    "LocalAI": ("git", "Locus/LocalAI", "c03a3c4d3122a43da70ceebef976b26ce6c15c00", ""),
    "MailHub": ("git", "MailHub", "6f21dee38489f9bc973f5e0a9c990a7b4dbfbbd4", ""),
    "HUBTender": ("git", "HUBTender", "798213b55aa8ceb1f2385ecf01bc55e89da0ff23", ""),
    "ApiTenderHub": (
        "zip",
        "Quantor/ApiTenderHub.zip",
        "f737ca6ba1f1474b7e55da1cfa8d7d9faea09c6f5997a134db6783a80f9109c4",
        "ApiTenderHub/",
    ),
    "RDWeb": (
        "zip",
        "Quantor/_prompts/stage1/fixtures/legacy/01-03-00-01-12_ПД-00260560-АР.zip",
        "b6bdfd4e74e334a10b8d4e88ad898461534bf52f8668904fc960764561be9ae1",
        "",
    ),
}
MATERIAL_FLAGS = {
    "LocalAI": "--localai",
    "MailHub": "--mailhub",
    "HUBTender": "--hubtender",
    "ApiTenderHub": "--api-zip",
    "RDWeb": "--rdweb-zip",
}
DOCS = [
    "docs/discovery.md",
    "docs/decisions.md",
    "docs/defects.md",
    "docs/project-state.md",
    "docs/requirements-traceability.md",
    "docs/integrations/status.md",
    "docs/reviews/00-review-1.md",
    "docs/stages/00-report.md",
]
TRACE_DOC = "docs/requirements-traceability.md"
DISCOVERY_DOC = "docs/discovery.md"
# Реестры, где ID вопросов, неизвестных и доработок считаются определёнными.
# Этап 01 ведёт свой реестр, поэтому он добавляется к discovery, если существует.
EXTRA_ID_SOURCES = ["docs/architecture/unknowns.md"]
RDWEB_EXPECTED = {
    "schema_version": 1,
    "pages": 77,
    "rotation": {90: 47, 0: 30},
    "blocks": 383,
    "block_type": {"text": 230, "image": 90, "stamp": 63},
    "md_pages": 77,
    "md_blocks": 320,
    "json_only_types": {"stamp": 63},
}
REF_RE = re.compile(r"`(LocalAI|MailHub|HUBTender|ApiTenderHub):([^`:]+):([\d,\-]+)`")
SECRET_RE = re.compile(
    r"thk_[A-Za-z0-9]{8,}"
    r"|Bearer\s+[A-Za-z0-9._\-]{16,}"
    r"|postgres(?:ql)?://[^\s:@/]+:[^\s@/]+@"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY"
    r"|AKIA[0-9A-Z]{16}"
    r"|sk-[A-Za-z0-9]{20,}"
    r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."
)


@dataclasses.dataclass(frozen=True)
class Material:
    alias: str
    kind: str  # "git" или "zip"
    path: pathlib.Path
    expected: str  # ревизия для git, SHA-256 для zip
    prefix: str = ""


@dataclasses.dataclass(frozen=True)
class Config:
    docs_root: pathlib.Path
    docs: list
    trace_doc: str
    discovery_doc: str
    materials: dict  # ссылочные материалы: LocalAI, MailHub, HUBTender, ApiTenderHub
    rdweb: Material
    rdweb_expected: dict
    docs_only: bool = False
    extra_id_sources: list = dataclasses.field(default_factory=list)


@dataclasses.dataclass(frozen=True)
class Result:
    status: str
    name: str
    detail: str = ""


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def material_state(material):
    """PASS — доступен и совпадает; BLOCKED — недоступен; FAIL — содержимое отличается."""
    if not material.path.exists():
        return BLOCKED, f"не найден: {material.path}"
    if material.kind == "git":
        try:
            probe = subprocess.run(
                ["git", "-C", str(material.path), "cat-file", "-e", f"{material.expected}^{{commit}}"],
                capture_output=True,
            )
        except OSError as error:
            return BLOCKED, f"git недоступен: {error}"
        if probe.returncode != 0:
            return BLOCKED, f"нет ревизии {material.expected[:12]} в {material.path}"
        return PASS, f"ревизия {material.expected[:12]}"
    try:
        digest = sha256(material.path)
    except OSError as error:
        return BLOCKED, f"не читается: {error}"
    if digest != material.expected:
        return FAIL, f"SHA-256 {digest[:12]}…, ожидался {material.expected[:12]}…"
    return PASS, f"SHA-256 {digest[:12]}…"


def read_material_text(material, rel_path):
    if material.kind == "git":
        result = subprocess.run(
            ["git", "-C", str(material.path), "show", f"{material.expected}:{rel_path}"],
            capture_output=True,
        )
        return result.stdout.decode("utf-8", errors="replace") if result.returncode == 0 else None
    with zipfile.ZipFile(material.path) as archive:
        try:
            return archive.read(material.prefix + rel_path).decode("utf-8")
        except KeyError:
            return None


def read_doc(config, doc):
    return (config.docs_root / doc).read_text(encoding="utf-8")


def check_refs(config):
    refs, results = collections.defaultdict(list), []
    for doc in config.docs:
        try:
            text = read_doc(config, doc)
        except (OSError, UnicodeDecodeError):
            continue  # отсутствие и кодировку документа отмечает check_text
        for alias, rel_path, ranges in REF_RE.findall(text):
            refs[alias].append((doc, rel_path, ranges))
    total = sum(len(items) for items in refs.values())
    results.append(Result(PASS if total else FAIL, f"ссылки на исходники найдены в документах ({total} шт.)"))

    for alias, material in config.materials.items():
        items = refs.get(alias, [])
        name = f"ссылки {alias} ({len(items)} шт.)"
        if config.docs_only:
            results.append(Result(NOT_RUN, name, "режим --docs-only"))
            continue
        state, detail = material_state(material)
        results.append(Result(state, f"материал {alias}", detail))
        if state != PASS:
            results.append(Result(BLOCKED, name, "материал недоступен или отличается"))
            continue
        bad, line_counts = [], {}
        for doc, rel_path, ranges in items:
            if rel_path not in line_counts:
                try:
                    text = read_material_text(material, rel_path)
                except (OSError, zipfile.BadZipFile):
                    text = None
                line_counts[rel_path] = None if text is None else len(text.splitlines())
            count = line_counts[rel_path]
            numbers = [int(number) for part in ranges.split(",") for number in part.split("-") if number]
            if count is None or not numbers or min(numbers) < 1 or max(numbers) > count:
                bad.append(f"{doc}: {alias}:{rel_path}:{ranges} (строк: {count})")
        results.append(Result(FAIL if bad else PASS, name, "; ".join(bad[:10])))
    return results


def check_ids(config):
    results = []
    try:
        trace = read_doc(config, config.trace_doc)
        discovery = read_doc(config, config.discovery_doc)
    except (OSError, UnicodeDecodeError) as error:
        return [Result(FAIL, "трассировка и discovery читаются", str(error))]

    missing = [f"I{n:02d}" for n in range(1, 20) if f"| I{n:02d} |" not in trace]
    results.append(Result(FAIL if missing else PASS, "I01–I19 в трассировке", ", ".join(missing)))
    missing = [f"A{n:02d}" for n in range(1, 47) if not re.search(rf"\bA{n:02d}\b", trace)]
    results.append(Result(FAIL if missing else PASS, "A01–A46 в трассировке", ", ".join(missing)))

    defined = set(re.findall(r"^\| ([XQUR]-\d{2}) \|", discovery, re.M))
    for extra in config.extra_id_sources:
        path = config.docs_root / extra
        if path.is_file():
            defined |= set(re.findall(r"^\| ([XQUR]-\d{2}) \|", path.read_text(encoding="utf-8"), re.M))
    used = set()
    for doc in config.docs:
        try:
            used |= set(re.findall(r"\b([XQUR]-\d{2})\b", read_doc(config, doc)))
        except (OSError, UnicodeDecodeError):
            continue
    undefined = sorted(used - defined)
    results.append(
        Result(FAIL if undefined else PASS, f"X/Q/U/R определены в discovery ({len(defined)} шт.)", ", ".join(undefined))
    )
    return results


def check_text(config):
    results = []
    for doc in config.docs:
        try:
            text = (config.docs_root / doc).read_bytes().decode("utf-8")
        except OSError as error:
            results.append(Result(FAIL, f"документ существует: {doc}", str(error)))
            continue
        except UnicodeDecodeError as error:
            results.append(Result(FAIL, f"UTF-8: {doc}", str(error)))
            continue
        hits = SECRET_RE.findall(text)
        results.append(Result(FAIL if hits else PASS, f"UTF-8 и нет секретов: {doc}", f"совпадений: {len(hits)}"))
    return results


def rdweb_stats(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        data = json.loads(archive.read(next(n for n in names if n.endswith("_blocks.json"))).decode("utf-8"))
        markdown = archive.read(next(n for n in names if n.endswith("_results.md"))).decode("utf-8")
    blocks = data["blocks"]
    md_ids = set(re.findall(r"^### BLOCK #\d+ \[[A-Z]+\]: (\S+)", markdown, re.M))
    return {
        "schema_version": data["schema_version"],
        "pages": len(data["pages"]),
        "rotation": dict(collections.Counter(page["rotation"] for page in data["pages"])),
        "blocks": len(blocks),
        "block_type": dict(collections.Counter(block["block_type"] for block in blocks)),
        "md_pages": len(re.findall(r"^## Page \d+", markdown, re.M)),
        "md_blocks": len(md_ids),
        "json_only_types": dict(collections.Counter(b["block_type"] for b in blocks if b["block_id"] not in md_ids)),
    }


def check_rdweb(config):
    if config.docs_only:
        return [Result(NOT_RUN, "образец RDWeb: счётчики", "режим --docs-only")]
    state, detail = material_state(config.rdweb)
    results = [Result(state, "материал RDWeb", detail)]
    if state != PASS:
        return results + [Result(BLOCKED, "образец RDWeb: счётчики", "материал недоступен или отличается")]
    try:
        actual = rdweb_stats(config.rdweb.path)
    except (OSError, zipfile.BadZipFile, KeyError, StopIteration, ValueError) as error:
        return results + [Result(FAIL, "образец RDWeb: счётчики", f"не удалось разобрать: {error!r}")]
    for key, expected in config.rdweb_expected.items():
        results.append(
            Result(
                PASS if actual.get(key) == expected else FAIL,
                f"образец RDWeb: {key}",
                f"факт {actual.get(key)}, ожидалось {expected}",
            )
        )
    return results


def run(config):
    return check_refs(config) + check_ids(config) + check_text(config) + check_rdweb(config)


def summarize(results, docs_only=False):
    statuses = {result.status for result in results}
    if FAIL in statuses:
        return "FAIL", 1
    if BLOCKED in statuses:
        return "BLOCKED", 2
    if docs_only or NOT_RUN in statuses:
        return "PARTIAL", 3
    return "PASS", 0


def build_config(argv=None):
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Проверки документов этапа 00")
    parser.add_argument("--workspace", default=str(repo_root.parent), help="каталог с материалами по путям по умолчанию")
    parser.add_argument("--materials", help="JSON-manifest путей к материалам")
    for alias, flag in MATERIAL_FLAGS.items():
        parser.add_argument(flag, dest=alias, help=f"путь к материалу {alias}")
    parser.add_argument("--docs-only", action="store_true", help="только проверки документов; итог PARTIAL")
    args = parser.parse_args(argv)

    manifest = {}
    if args.materials:
        manifest_path = pathlib.Path(args.materials).resolve()
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            parser.error(f"manifest не читается: {error}")
        unknown = sorted(set(raw) - set(DEFAULT_MATERIALS))
        if unknown:
            parser.error(f"неизвестные материалы в manifest: {', '.join(unknown)}")
        manifest = {alias: manifest_path.parent / value for alias, value in raw.items()}

    workspace = pathlib.Path(args.workspace).resolve()
    materials = {}
    for alias, (kind, default_path, expected, prefix) in DEFAULT_MATERIALS.items():
        flag_value = getattr(args, alias)
        path = pathlib.Path(flag_value) if flag_value else manifest.get(alias, workspace / default_path)
        materials[alias] = Material(alias, kind, path.resolve(), expected, prefix)
    rdweb = materials.pop("RDWeb")
    return Config(
        docs_root=repo_root,
        docs=DOCS,
        trace_doc=TRACE_DOC,
        discovery_doc=DISCOVERY_DOC,
        materials=materials,
        rdweb=rdweb,
        rdweb_expected=RDWEB_EXPECTED,
        docs_only=args.docs_only,
        extra_id_sources=EXTRA_ID_SOURCES,
    )


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    config = build_config(argv)
    results = run(config)
    verdict, code = summarize(results, config.docs_only)
    for result in results:
        print(f"{result.status:<8} {result.name}{(' — ' + result.detail) if result.detail else ''}")
    unchecked = [result.name for result in results if result.status in (BLOCKED, NOT_RUN)]
    print("\nСсылки проверяются на существование диапазонов строк, а не на истинность утверждений.")
    if unchecked:
        print("Непроверено: " + "; ".join(unchecked))
    print(f"Итог: {verdict} (код {code})")
    return code


if __name__ == "__main__":
    sys.exit(main())
