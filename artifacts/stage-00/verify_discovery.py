"""Проверки документов этапа 00.

1. Ссылки `Система:путь:строки` существуют в зафиксированных ревизиях.
2. Все I01–I19 и A01–A46 есть в трассировке требований.
3. Все упомянутые X-/Q-/U-/R- определены в discovery.
4. В документах нет похожих на секреты строк; файлы — валидный UTF-8.
5. Счётчики образца RDWeb совпадают с discovery §7.1 (если архив доступен).

Запуск из корня репозитория портала:
    python artifacts/stage-00/verify_discovery.py [--workspace ПУТЬ]
Код выхода 0 — все проверки пройдены. Только чтение.
"""

import argparse
import collections
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile

REPOS = {
    "LocalAI": ("Locus/LocalAI", "c03a3c4d3122a43da70ceebef976b26ce6c15c00"),
    "MailHub": ("MailHub", "6f21dee38489f9bc973f5e0a9c990a7b4dbfbbd4"),
    "HUBTender": ("HUBTender", "798213b55aa8ceb1f2385ecf01bc55e89da0ff23"),
}
API_ZIP = ("Quantor/ApiTenderHub.zip", "f737ca6ba1f1474b7e55da1cfa8d7d9faea09c6f5997a134db6783a80f9109c4")
RDWEB_ZIP = (
    "Quantor/_prompts/stage1/fixtures/legacy/01-03-00-01-12_ПД-00260560-АР.zip",
    "b6bdfd4e74e334a10b8d4e88ad898461534bf52f8668904fc960764561be9ae1",
)
DOCS = [
    "docs/discovery.md",
    "docs/decisions.md",
    "docs/project-state.md",
    "docs/requirements-traceability.md",
    "docs/integrations/status.md",
    "docs/stages/00-report.md",
]
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

failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(name)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def line_count_at_revision(workspace, alias, rel_path, cache):
    key = (alias, rel_path)
    if key in cache:
        return cache[key]
    if alias == "ApiTenderHub":
        with zipfile.ZipFile(workspace / API_ZIP[0]) as archive:
            text = archive.read(f"ApiTenderHub/{rel_path}").decode("utf-8")
    else:
        repo, revision = REPOS[alias]
        result = subprocess.run(
            ["git", "-C", str(workspace / repo), "show", f"{revision}:{rel_path}"],
            capture_output=True,
        )
        if result.returncode != 0:
            cache[key] = None
            return None
        text = result.stdout.decode("utf-8", errors="replace")
    cache[key] = len(text.splitlines())
    return cache[key]


def check_refs(repo_root, workspace):
    zip_path = workspace / API_ZIP[0]
    check("архив API TenderHub: SHA-256", zip_path.exists() and sha256(zip_path) == API_ZIP[1])
    cache, bad, total = {}, [], 0
    for doc in DOCS:
        text = (repo_root / doc).read_text(encoding="utf-8")
        for alias, rel_path, ranges in REF_RE.findall(text):
            total += 1
            count = line_count_at_revision(workspace, alias, rel_path, cache)
            numbers = [int(n) for part in ranges.split(",") for n in part.split("-") if n]
            if count is None or not numbers or max(numbers) > count:
                bad.append(f"{doc}: {alias}:{rel_path}:{ranges} (строк: {count})")
    check(f"ссылки на исходники существуют в ревизиях ({total} шт.)", total > 0 and not bad, "; ".join(bad[:10]))


def check_ids(repo_root):
    trace = (repo_root / "docs/requirements-traceability.md").read_text(encoding="utf-8")
    missing = [f"I{n:02d}" for n in range(1, 20) if f"| I{n:02d} |" not in trace]
    check("I01–I19 в трассировке", not missing, ", ".join(missing))
    missing = [f"A{n:02d}" for n in range(1, 47) if not re.search(rf"\bA{n:02d}\b", trace)]
    check("A01–A46 в трассировке", not missing, ", ".join(missing))

    discovery = (repo_root / "docs/discovery.md").read_text(encoding="utf-8")
    defined = set(re.findall(r"^\| ([XQUR]-\d{2}) \|", discovery, re.M))
    used = set()
    for doc in DOCS:
        used |= set(re.findall(r"\b([XQUR]-\d{2})\b", (repo_root / doc).read_text(encoding="utf-8")))
    undefined = sorted(used - defined)
    check(f"X/Q/U/R определены в discovery ({len(defined)} шт.)", not undefined, ", ".join(undefined))


def check_text(repo_root):
    for doc in DOCS:
        raw = (repo_root / doc).read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            check(f"UTF-8: {doc}", False, str(error))
            continue
        hits = SECRET_RE.findall(text)
        check(f"UTF-8 и нет секретов: {doc}", not hits, f"совпадений: {len(hits)}")


def check_rdweb(workspace):
    path = workspace / RDWEB_ZIP[0]
    if not path.exists():
        print("SKIP  образец RDWeb недоступен")
        return
    check("образец RDWeb: SHA-256", sha256(path) == RDWEB_ZIP[1])
    with zipfile.ZipFile(path) as archive:
        name = lambda suffix: next(n for n in archive.namelist() if n.endswith(suffix))
        data = json.loads(archive.read(name("_blocks.json")).decode("utf-8"))
        markdown = archive.read(name("_results.md")).decode("utf-8")
    blocks = data["blocks"]
    md_ids = set(re.findall(r"^### BLOCK #\d+ \[[A-Z]+\]: (\S+)", markdown, re.M))
    actual = {
        "schema_version": data["schema_version"],
        "pages": len(data["pages"]),
        "rotation": dict(collections.Counter(page["rotation"] for page in data["pages"])),
        "blocks": len(blocks),
        "block_type": dict(collections.Counter(block["block_type"] for block in blocks)),
        "md_pages": len(re.findall(r"^## Page \d+", markdown, re.M)),
        "md_blocks": len(md_ids),
        "json_only_types": dict(collections.Counter(b["block_type"] for b in blocks if b["block_id"] not in md_ids)),
    }
    for key, expected in RDWEB_EXPECTED.items():
        check(f"образец RDWeb: {key}", actual[key] == expected, f"факт {actual[key]}, ожидалось {expected}")


def main():
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=str(repo_root.parent))
    workspace = pathlib.Path(parser.parse_args().workspace).resolve()
    check_refs(repo_root, workspace)
    check_ids(repo_root)
    check_text(repo_root)
    check_rdweb(workspace)
    print(f"\nИтог: {'FAIL' if failures else 'PASS'} ({len(failures)} ошибок)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
